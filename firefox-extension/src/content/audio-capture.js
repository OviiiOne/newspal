// audio-capture.js — Gladia (primary) + Whisper local (fallback)
// Firefox: uses getDisplayMedia for tab audio capture in both modes
// Gladia: real-time via WebSocket, best quality + diarization
// Whisper: local model via transformers.js, no API key needed, ~75MB download once

// With all_frames the content scripts run in EVERY frame of the page. The top frame
// owns the UI (overlay.js checks this same constant); audio capture runs in whichever
// frame actually has the media element, coordinated via CLAIM_CAPTURE (background).
const IS_TOP_FRAME = (() => { try { return window.top === window; } catch { return false; } })();

let mediaStream = null;
let audioContext = null;
let socket = null;
let captureActive = false;
let pendingStart = false; // start in progress (may be waiting for the page's player)
let usedPageMediaCapture = false; // capturing the page's own <video>/<audio> (vs a device)
let capturedMediaEl = null; // that element — the silence watchdog checks it is really playing
let utteranceBuffer = '';
let gladiaKey = '';
let gladiaProxyUrl = ''; // set when Gladia should be started via the proxy (key server-side)
let proxyToken = '';     // shared secret sent to the proxy
let sourceLanguage = 'auto'; // 'auto' | ISO code (es, en, fr, ar, he, fa, ...)
let transcriptionMode = 'none'; // 'gladia' | 'whisper'

// Multilingual Whisper model (replaces English-only whisper-tiny.en).
const WHISPER_MODEL = 'onnx-community/whisper-base';

// NOTE: 'auto' must send an EMPTY languages list. Per the Gladia live API reference,
// `languages` means "if ONE language is set, use it; otherwise auto-detect" — it is not
// a shortlist to choose from. Passing the 14 popup languages was therefore not a
// restriction but an undefined case (most likely pinning the first entry, 'es'), which
// is why a Japanese press conference transcribed to nothing. Gladia live covers 99+
// languages, so full auto-detection is both correct and wider than any list we'd keep.

// Whisper state
let whisperPipeline = null;
let whisperChunks = [];
let whisperProcessor = null;
let whisperInterval = null;
let whisperLoading = false;
const WHISPER_CHUNK_SECONDS = 5;
const WHISPER_SAMPLE_RATE = 16000;

// Capture audio straight from the page's own media element (Firefox uses the
// prefixed mozCaptureStream). This gives the exact tab audio with no mic, no screen
// share and no OS loopback. Returns null if there's no usable element (e.g. the
// player lives in a cross-origin iframe, or the media is tainted).
function getPageMediaStream(strict = false) {
  const els = [...document.querySelectorAll('video, audio')];
  const active = els.find(e => !e.paused && !e.muted && e.readyState >= 2);
  // strict (iframes): only an actually playing, unmuted element counts — otherwise a
  // muted ad video in some other iframe could steal the capture slot from the player.
  const el = strict
    ? active
    : (active || els.find(e => e.readyState >= 2) || els[0]);
  if (!el) return null;
  const capture = el.captureStream || el.mozCaptureStream;
  if (!capture) return null;
  try {
    const stream = capture.call(el);
    if (stream && stream.getAudioTracks().length) { capturedMediaEl = el; return stream; }
    return null;
  } catch (err) {
    console.warn('[audio-capture] captureStream failed:', err);
    return null;
  }
}

// ── Capture-slot coordination (multi-frame) ─────────────────────────────────

// The top frame without a player waits briefly for an iframe to claim the capture
// slot before falling back to a system-audio device (avoids a useless mic prompt
// when the video lives in an embed, e.g. Vimeo).
let captureClaimNotify = null;

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'CAPTURE_CLAIMED' && captureClaimNotify) captureClaimNotify();
});

function waitForCaptureClaim(ms) {
  return new Promise((resolve) => {
    let done = false;
    captureClaimNotify = () => {
      if (!done) { done = true; captureClaimNotify = null; resolve(true); }
    };
    setTimeout(() => {
      if (!done) { done = true; captureClaimNotify = null; resolve(false); }
    }, ms);
  });
}

// A resume lands right after the page reloaded, when the player is usually not mounted
// yet and the video is paused. Grabbing nothing there used to fall through to the
// microphone fallback, which popped a permission prompt and would have captured the
// wrong audio anyway. Wait for the player instead — strictly (playing and unmuted), so
// a leftover paused element doesn't get captured as silence.
const RESUME_MEDIA_WAIT_MS = 300000; // 5 min: he may take a while to hit play again

async function waitForPageMedia(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let claimed = false;
  const previousNotify = captureClaimNotify;
  captureClaimNotify = () => { claimed = true; };
  try {
    while (Date.now() < deadline && pendingStart && !claimed) {
      const stream = getPageMediaStream(true);
      if (stream) return { stream, claimed: false };
      await new Promise(r => setTimeout(r, 500));
    }
  } finally {
    captureClaimNotify = previousNotify;
  }
  return { stream: null, claimed };
}

async function claimCaptureSlot() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CLAIM_CAPTURE' });
    return !!(resp && resp.granted);
  } catch {
    // No background answer (shouldn't happen): let the top frame proceed alone.
    return IS_TOP_FRAME;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function startAudioCapture(opts) {
  if (captureActive || pendingStart) return;
  pendingStart = true;

  // Resuming after a page reload; captureMode is how the session captured audio BEFORE
  // the reload (the background remembers it), so a device-based session doesn't sit
  // waiting for a player that was never being used.
  const resuming = !!(opts && opts.resume);
  const previousMode = (opts && opts.captureMode) || null;
  const previousGladiaUrl = (opts && opts.gladiaSessionUrl) || '';

  const data = await browser.storage.local.get(['gladiaKey', 'sourceLanguage', 'proxyUrl', 'connectionMode', 'proxyToken', 'uiLanguage']);
  gladiaKey = data.gladiaKey || '';
  sourceLanguage = data.sourceLanguage || 'auto';
  proxyToken = data.proxyToken || '';
  setUiLang(data.uiLanguage || defaultUiLanguage());

  // In proxy mode without a direct key, start Gladia through the proxy so the
  // Gladia key stays on the server (Railway), never in the browser.
  gladiaProxyUrl = '';
  if (!gladiaKey && data.connectionMode === 'proxy' && data.proxyUrl) {
    try { gladiaProxyUrl = new URL('/gladia/live', data.proxyUrl).href; }
    catch { gladiaProxyUrl = ''; }
  }

  // 1) Best path: capture the page's own <video>/<audio> directly — exact tab audio,
  //    no mic, no OS setup. With all_frames this also runs inside cross-origin
  //    iframes (Vimeo embeds), so whichever frame has the player captures it.
  // 2) Fallback (top frame only): a system-audio INPUT device (loopback).
  // Strict on a resume even in the top frame: right after a reload the <video> often
  // exists but is paused, and the loose match would happily capture it — silence for the
  // rest of the session. Better to find nothing and wait for play.
  mediaStream = getPageMediaStream(!IS_TOP_FRAME || resuming);

  // The page has just reloaded: the player usually needs a few seconds to mount and the
  // video is paused until the user hits play. Wait for it rather than prompting for a
  // microphone. Skipped when the session was capturing from a device anyway.
  if (!mediaStream && resuming && previousMode !== 'device') {
    browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: t('ac_waiting_player') });
    const waited = await waitForPageMedia(RESUME_MEDIA_WAIT_MS);
    mediaStream = waited.stream;
    if (!mediaStream) {
      // Another frame took the slot, or the video never came back.
      if (!waited.claimed) {
        browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: t('ac_player_gone') });
      }
      pendingStart = false;
      return;
    }
  }

  const usedPageMedia = !!mediaStream;
  usedPageMediaCapture = usedPageMedia;

  if (mediaStream) {
    // Several frames may have media — only the first to claim the slot captures.
    if (!(await claimCaptureSlot())) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
      pendingStart = false;
      return;
    }
  } else {
    // Iframes never fall back to an input device; that choice belongs to the top frame.
    if (!IS_TOP_FRAME) { pendingStart = false; return; }

    // Give iframes a moment to find their player and claim the slot.
    if (await waitForCaptureClaim(2500)) { pendingStart = false; return; }
    if (!(await claimCaptureSlot())) { pendingStart = false; return; }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      console.error('[audio-capture] getUserMedia error:', err);
      browser.runtime.sendMessage({
        type: 'PIPELINE_ERROR',
        message: err.name === 'NotAllowedError'
          ? t('ac_perm_denied')
          : t('ac_capture_fail') + err.message,
      });
      pendingStart = false;
      return;
    }
  }

  const audioTracks = mediaStream.getAudioTracks();
  if (!audioTracks.length) {
    browser.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: t('ac_no_audio'),
    });
    pendingStart = false;
    stopAudioCapture();
    return;
  }

  captureActive = true;
  pendingStart = false;
  // Tell the background how we captured, so a resume after a reload doesn't wait for a
  // player when the session was running off an audio device.
  browser.runtime.sendMessage({ type: 'CAPTURE_MODE', mode: usedPageMedia ? 'page' : 'device' });

  const src = usedPageMedia ? t('ac_src_video') : t('ac_src_device');
  const eng = gladiaProxyUrl ? t('ac_gladia_proxy')
            : gladiaKey ? t('ac_gladia_direct')
            : t('ac_whisper');
  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: fmt(t('ac_capturing'), { src, eng }),
  });

  if (gladiaKey || gladiaProxyUrl) {
    transcriptionMode = 'gladia';
    utteranceBuffer = '';
    if (resuming && previousGladiaUrl) await releasePreviousGladiaSession(previousGladiaUrl);
    connectGladia();
  } else {
    transcriptionMode = 'whisper';
    startWithWhisper();
  }
}

// ── Gladia (primary) ─────────────────────────────────────────────────────────

// A failed init used to end the session on the spot. After a page reload that meant the
// press conference stopped transcribing silently, with a manual stop+start as the only
// way back. Retry with backoff instead, and only give up at once on the errors a retry
// cannot fix: the documented 400 / 401 / 422 mean the key or the parameters are wrong.
// Anything else — network failures, our proxy's 502, or an undocumented status — is
// treated as a hiccup worth retrying.
// Long enough to outlast a slot still locked despite the stop_recording above (Gladia
// documents no timeout for an abrupt disconnect, so this is deliberately generous: a
// press conference is worth waiting two minutes for).
const GLADIA_INIT_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000, 45000];

function gladiaInitIsFatal(status) {
  return status === 400 || status === 401 || status === 422;
}

async function requestGladiaSession() {
  // Direct (key in browser) or via proxy (key on server). Proxy forwards to Gladia.
  const initUrl = gladiaKey ? 'https://api.gladia.io/v2/live' : gladiaProxyUrl;
  const initHeaders = gladiaKey
    ? { 'Content-Type': 'application/json', 'x-gladia-key': gladiaKey }
    : { 'Content-Type': 'application/json' };
  if (!gladiaKey && proxyToken) initHeaders['x-proxy-token'] = proxyToken;

  return fetch(initUrl, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify({
      encoding: 'wav/pcm',
      sample_rate: 16000,
      channels: 1,
      // 'auto' → empty list lets Gladia auto-detect (code_switching re-detects on each
      // utterance, so a bilingual Q&A keeps working).
      // Specific language → pin it for best accuracy.
      language_config: sourceLanguage === 'auto'
        ? { languages: [], code_switching: true }
        : { languages: [sourceLanguage], code_switching: false },
      realtime_processing: {
        words_accurate_timestamps: true,
      },
    }),
  });
}

async function connectGladia() {
  try {
    let initRes = null;
    let detail = '';
    let lastStatus = 0;

    for (let attempt = 0; attempt <= GLADIA_INIT_RETRY_DELAYS.length; attempt++) {
      if (!captureActive) return; // stopped while we were waiting
      detail = '';
      try {
        const res = await requestGladiaSession();
        if (res.ok) { initRes = res; break; }
        lastStatus = res.status;
        try { const e = await res.json(); detail = (e && e.error && e.error.message) || ''; } catch {}
        console.error('[gladia] init failed:', res.status, detail, 'attempt', attempt + 1);
        if (gladiaInitIsFatal(res.status)) break;
      } catch (err) {
        lastStatus = 0;
        detail = err.message || '';
        console.error('[gladia] init request threw:', detail, 'attempt', attempt + 1);
      }

      const delay = GLADIA_INIT_RETRY_DELAYS[attempt];
      if (delay === undefined) break; // attempts exhausted
      browser.runtime.sendMessage({
        type: 'PIPELINE_INFO',
        message: fmt(t('ac_gladia_retrying'), { n: attempt + 1, total: GLADIA_INIT_RETRY_DELAYS.length + 1 }),
      });
      await new Promise(r => setTimeout(r, delay));
    }

    if (!initRes) {
      const via = gladiaKey ? '' : t('ac_via_proxy');
      browser.runtime.sendMessage({
        type: 'PIPELINE_ERROR',
        message: fmt(t('ac_gladia_failed_status'), { via, status: lastStatus || '—' }) + (detail ? ' ' + detail : ''),
      });
      stopAudioCapture();
      return;
    }

    const initData = await initRes.json();
    const wsUrl = initData.url;
    // The background outlives a page reload, so it keeps this for the resume below.
    if (wsUrl) browser.runtime.sendMessage({ type: 'GLADIA_SESSION', url: wsUrl });

    if (!wsUrl) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: t('ac_no_session_url') });
      stopAudioCapture();
      return;
    }

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[audio-capture] gladia connected');
      browser.runtime.sendMessage({ type: 'CAPTURE_READY' });
      browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: t('ac_connected') });
      startGladiaPipeline();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'transcript') {
          const text = msg.data?.utterance?.text?.trim();
          if (!text) return;

          const isFinal = msg.data?.is_final === true;
          const speaker = msg.data?.utterance?.words?.[0]?.speaker ?? null;

          browser.runtime.sendMessage({
            type: 'TRANSCRIPT_RESULT',
            text,
            isFinal,
            interim: !isFinal,
            speaker,
            // Gladia detects the language of every utterance (BCP-47, e.g. "en"). It is
            // what decides whether a line needs translating — see needsTranslation().
            language: msg.data?.utterance?.language || null,
          });
        }
      } catch (err) {
        console.error('[gladia] message parse error:', err);
      }
    };

    socket.onerror = () => {
      browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: t('ac_fallback_whisper') });
      fallbackToWhisper();
    };

    socket.onclose = (e) => {
      console.log('[gladia] closed:', e.code, e.reason);
      if (captureActive && transcriptionMode === 'gladia') {
        if (e.code === 1008 || e.code === 4001 || e.code === 4003) {
          browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: fmt(t('ac_auth_failed'), { code: e.code }) });
          stopAudioCapture();
        } else {
          browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: fmt(t('ac_reconnecting'), { code: e.code, reason: e.reason ? ': ' + e.reason : '' }) });
          setTimeout(() => {
            if (captureActive && transcriptionMode === 'gladia') connectGladia();
          }, 2000);
        }
      }
    };

  } catch (err) {
    console.error('[gladia] connection error:', err);
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: fmt(t('ac_connect_error'), { msg: err.message }) });
    stopAudioCapture();
  }
}

// Gladia pipeline state: kept module-level so a reconnect can tear the previous
// pipeline down (before this, a reconnect stacked a SECOND processor on the same
// socket — duplicated audio — and a dead track was never noticed).
let gladiaSource = null;
let gladiaProcessor = null;
let gladiaKeepalive = null;
let gladiaWatchdog = null;
let lastChunkSentAt = 0;
let SILENT_CHUNK = null; // 100ms of silence, precomputed

// ── Silence watchdog ─────────────────────────────────────────────────────────
// A capture can connect to Gladia and still carry nothing: Firefox hands Web Audio pure
// silence for a video served from another origin (it only logs a console warning — no
// exception reaches us), and an AudioContext that never starts sends nothing either. The
// keepalive then keeps the session looking healthy, so nothing is ever transcribed and
// nothing says why. Real audio, even a quiet room, is never EXACTLY zero; a blocked
// stream is. So warn when only zeros arrive while the video is audibly playing.
// It only warns: press conferences open with silent waits, and cutting the session
// there would lose it.
const SILENCE_WARN_MS = 8000;
let lastSoundAt = 0;
let silenceWarned = false;
let gladiaSilenceCheck = null;

function bufferHasSound(samples) {
  for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) return true;
  return false;
}

// A paused, ended, muted or zero-volume player is silent on purpose.
function isAudiblyPlaying(el) {
  return !!el && !el.paused && !el.ended && !el.muted && el.volume > 0 && el.readyState >= 3;
}

// 'reset' (not audibly playing: that time doesn't count) | 'wait' | 'warn'.
function silenceVerdict(now, lastSound, el) {
  if (!isAudiblyPlaying(el)) return 'reset';
  return (now - lastSound >= SILENCE_WARN_MS) ? 'warn' : 'wait';
}

function silentChunkBase64() {
  if (!SILENT_CHUNK) SILENT_CHUNK = arrayBufferToBase64(new Int16Array(WHISPER_SAMPLE_RATE / 10).buffer);
  return SILENT_CHUNK;
}

function stopGladiaPipeline() {
  if (gladiaKeepalive) { clearInterval(gladiaKeepalive); gladiaKeepalive = null; }
  if (gladiaWatchdog) { clearInterval(gladiaWatchdog); gladiaWatchdog = null; }
  if (gladiaSilenceCheck) { clearInterval(gladiaSilenceCheck); gladiaSilenceCheck = null; }
  if (gladiaProcessor) { try { gladiaProcessor.disconnect(); } catch {} gladiaProcessor = null; }
  if (gladiaSource) { try { gladiaSource.disconnect(); } catch {} gladiaSource = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
}

function startGladiaPipeline() {
  if (!mediaStream) return;
  stopGladiaPipeline(); // never run two pipelines at once (reconnects)

  audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  gladiaSource = audioContext.createMediaStreamSource(mediaStream);

  gladiaProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  gladiaProcessor.onaudioprocess = (e) => {
    if (socket?.readyState !== WebSocket.OPEN) return;

    const float32 = e.inputBuffer.getChannelData(0);
    if (bufferHasSound(float32)) { lastSoundAt = Date.now(); silenceWarned = false; }
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }

    const base64 = arrayBufferToBase64(int16.buffer);
    // Gladia v2 live expects this exact shape for streamed audio.
    socket.send(JSON.stringify({ type: 'audio_chunk', data: { chunk: base64 } }));
    lastChunkSentAt = Date.now();
  };

  gladiaSource.connect(gladiaProcessor);
  gladiaProcessor.connect(audioContext.destination);

  lastChunkSentAt = Date.now();

  // Keepalive: when the video stalls to buffer, the audio flow stops; with no chunks
  // arriving Gladia times the session out and transcription dies SILENTLY. Feed it
  // short silent chunks while the real audio is interrupted.
  gladiaKeepalive = setInterval(() => {
    if (!captureActive || transcriptionMode !== 'gladia') return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastChunkSentAt < 1500) return;
    socket.send(JSON.stringify({ type: 'audio_chunk', data: { chunk: silentChunkBase64() } }));
    lastChunkSentAt = Date.now();
  }, 1000);

  // Watchdog: some players KILL their captured track when they rebuffer or switch
  // quality — the pipeline then hangs on a dead track forever. Re-grab the page
  // media and rebuild the pipeline onto the same socket.
  gladiaWatchdog = setInterval(() => {
    if (!captureActive || transcriptionMode !== 'gladia' || !mediaStream) return;
    if (!usedPageMediaCapture) return; // device capture: nothing to re-grab
    const track = mediaStream.getAudioTracks()[0];
    if (track && track.readyState !== 'ended') return;
    const fresh = getPageMediaStream(!IS_TOP_FRAME);
    if (!fresh) return; // player not back yet — retry on the next tick
    mediaStream.getTracks().forEach(tr => tr.stop());
    mediaStream = fresh;
    startGladiaPipeline();
    browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: t('ac_recaptured') });
  }, 4000);

  // Silence watchdog (see bufferHasSound). Page capture only: a quiet input device is
  // legitimate, and there is no player to ask whether it is playing.
  lastSoundAt = Date.now();
  silenceWarned = false;
  gladiaSilenceCheck = setInterval(() => {
    if (!captureActive || transcriptionMode !== 'gladia' || silenceWarned) return;
    if (!usedPageMediaCapture) return;
    const verdict = silenceVerdict(Date.now(), lastSoundAt, capturedMediaEl);
    if (verdict === 'reset') { lastSoundAt = Date.now(); return; }
    if (verdict !== 'warn') return;
    silenceWarned = true;
    const contextState = audioContext ? audioContext.state : 'none';
    console.warn('[audio-capture] only silence for', SILENCE_WARN_MS, 'ms while the video plays; AudioContext:', contextState);
    browser.runtime.sendMessage({
      type: 'CAPTURE_SILENT',
      message: fmt(t('ac_no_sound'), { s: SILENCE_WARN_MS / 1000 }),
      // Evidence for the export: a context that never started is a different fault from a
      // blocked cross-origin stream (which runs, but only yields zeros).
      contextState,
    });
  }, 2000);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Gladia's free plan allows ONE live session at a time, and closing the socket does NOT
// end the session on their side — only the documented {"type":"stop_recording"} message
// does. Without it the dead session keeps the slot, so the next init is refused: exactly
// what happens a second after a page reload, and after any stop + start.
function endGladiaSession() {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop_recording' }));
    }
  } catch { /* the socket is already going down */ }
  try { socket.close(); } catch { /* idem */ }
  socket = null;
}

// A reload tears the page down without any of our stop paths running, which is how the
// slot was being leaked. Best effort: the browser may kill the socket before the frame
// is flushed — releasePreviousGladiaSession() below is the deterministic counterpart.
window.addEventListener('pagehide', endGladiaSession);

// Doing it at pagehide is a race against the browser; on a resume there is no rush. The
// background kept the previous session's URL across the reload, so reopen it, send the
// documented stop_recording, and only then ask for a new session — otherwise the free
// plan's single slot is still held by a session nobody is listening to.
// Reconnecting to an existing session URL is NOT documented, so this stays best effort:
// on any failure we fall through to the init, which retries.
function releasePreviousGladiaSession(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    let ws;
    try { ws = new WebSocket(url); } catch { return finish(); }
    const giveUp = setTimeout(() => { try { ws.close(); } catch {} finish(); }, 4000);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: 'stop_recording' })); } catch {}
      // Give the message a moment to go out before closing.
      setTimeout(() => { clearTimeout(giveUp); try { ws.close(); } catch {} finish(); }, 500);
    };
    ws.onerror = () => { clearTimeout(giveUp); finish(); };
    ws.onclose = () => { clearTimeout(giveUp); finish(); };
  });
}

// ── Whisper local (fallback) ─────────────────────────────────────────────────

function fallbackToWhisper() {
  transcriptionMode = 'whisper'; // set FIRST so the closing socket doesn't reconnect
  endGladiaSession();
  stopGladiaPipeline();
  // Keep mediaStream — we reuse it for Whisper
  startWithWhisper();
}

async function startWithWhisper() {
  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: t('ac_whisper_loading'),
  });

  try {
    await loadWhisperModel();
  } catch (err) {
    console.error('[whisper] model load error:', err);
    browser.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: t('ac_whisper_load_error') + err.message,
    });
    return;
  }

  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: t('ac_whisper_ready'),
  });
  browser.runtime.sendMessage({ type: 'CAPTURE_READY' });

  startWhisperPipeline();
}

async function loadWhisperModel() {
  if (whisperPipeline) return;
  if (whisperLoading) return;
  whisperLoading = true;

  try {
    // Content scripts can't use dynamic import() from CDN directly.
    // Inject transformers.js into the page context and bridge back via CustomEvent.
    const loaded = await new Promise((resolve, reject) => {
      const handler = (e) => {
        window.removeEventListener('__intruth_whisper_ready', handler);
        if (e.detail?.error) reject(new Error(e.detail.error));
        else resolve(true);
      };
      window.addEventListener('__intruth_whisper_ready', handler);

      const script = document.createElement('script');
      script.textContent = `
        (async () => {
          try {
            const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');
            window.__intruth_pipeline = await pipeline(
              'automatic-speech-recognition',
              '${WHISPER_MODEL}',
              { dtype: 'q8', device: 'wasm' }
            );
            window.dispatchEvent(new CustomEvent('__intruth_whisper_ready', { detail: { ok: true } }));
          } catch (err) {
            window.dispatchEvent(new CustomEvent('__intruth_whisper_ready', { detail: { error: err.message } }));
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      setTimeout(() => reject(new Error('Whisper model load timed out (60s)')), 60000);
    });

    // Bridge: content script calls page-context pipeline via CustomEvent
    whisperPipeline = {
      transcribe: (audioData, opts) => {
        return new Promise((resolve, reject) => {
          const handler = (e) => {
            window.removeEventListener('__intruth_whisper_result', handler);
            if (e.detail?.error) reject(new Error(e.detail.error));
            else resolve(e.detail.result);
          };
          window.addEventListener('__intruth_whisper_result', handler);

          // Pass audio as array (CustomEvent can carry structured clone data)
          window.dispatchEvent(new CustomEvent('__intruth_whisper_transcribe', {
            detail: { audio: Array.from(audioData), opts }
          }));

          setTimeout(() => reject(new Error('Whisper transcription timed out')), 30000);
        });
      }
    };

    // Inject the transcription listener into page context
    const listenerScript = document.createElement('script');
    listenerScript.textContent = `
      window.addEventListener('__intruth_whisper_transcribe', async (e) => {
        try {
          const audio = new Float32Array(e.detail.audio);
          const result = await window.__intruth_pipeline(audio, e.detail.opts || {});
          window.dispatchEvent(new CustomEvent('__intruth_whisper_result', { detail: { result } }));
        } catch (err) {
          window.dispatchEvent(new CustomEvent('__intruth_whisper_result', { detail: { error: err.message } }));
        }
      });
    `;
    document.documentElement.appendChild(listenerScript);
    listenerScript.remove();

    console.log('[whisper] model loaded via page context bridge');
  } finally {
    whisperLoading = false;
  }
}

function startWhisperPipeline() {
  if (!mediaStream) return;

  audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);

  whisperChunks = [];
  whisperProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  whisperProcessor.onaudioprocess = (e) => {
    if (!captureActive || transcriptionMode !== 'whisper') return;
    const samples = new Float32Array(e.inputBuffer.getChannelData(0));
    whisperChunks.push(samples);
  };

  source.connect(whisperProcessor);
  whisperProcessor.connect(audioContext.destination);

  // Process accumulated audio every WHISPER_CHUNK_SECONDS
  whisperInterval = setInterval(() => {
    if (!captureActive || transcriptionMode !== 'whisper') return;
    processWhisperChunks();
  }, WHISPER_CHUNK_SECONDS * 1000);

  console.log('[whisper] audio pipeline started, chunking every', WHISPER_CHUNK_SECONDS, 's');
}

let whisperProcessing = false;

async function processWhisperChunks() {
  if (!whisperPipeline || whisperProcessing) return;
  if (!whisperChunks.length) return;

  // Grab current chunks and reset buffer
  const chunks = whisperChunks;
  whisperChunks = [];

  // Merge into single Float32Array
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalLength < WHISPER_SAMPLE_RATE * 0.5) return; // skip if less than 0.5s

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Check if audio has actual content (not silence)
  let maxAmp = 0;
  for (let i = 0; i < merged.length; i += 100) {
    const abs = Math.abs(merged[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  if (maxAmp < 0.01) return; // skip silence

  whisperProcessing = true;

  try {
    // Send interim to show we're processing
    browser.runtime.sendMessage({
      type: 'TRANSCRIPT_RESULT',
      text: '...',
      isFinal: false,
      interim: true,
      speaker: null,
    });

    // 'auto' → omit language so multilingual Whisper detects it per chunk.
    const whisperOpts = {
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    if (sourceLanguage !== 'auto') whisperOpts.language = sourceLanguage;

    const result = await whisperPipeline.transcribe(merged, whisperOpts);

    const text = (result?.text || '').trim();
    if (text && text !== '...' && text.length > 1) {
      browser.runtime.sendMessage({
        type: 'TRANSCRIPT_RESULT',
        text,
        isFinal: true,
        interim: false,
        speaker: null,
      });
    }
  } catch (err) {
    console.error('[whisper] transcription error:', err);
  } finally {
    whisperProcessing = false;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

function stopAudioCapture() {
  captureActive = false;
  pendingStart = false; // also breaks a waitForPageMedia loop still running
  utteranceBuffer = '';
  transcriptionMode = 'none';

  if (whisperInterval) {
    clearInterval(whisperInterval);
    whisperInterval = null;
  }
  whisperChunks = [];

  stopGladiaPipeline();
  endGladiaSession();

  if (whisperProcessor) {
    whisperProcessor.disconnect();
    whisperProcessor = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  capturedMediaEl = null;

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}
