// session-export.js
// Handles session logging and HTML-report export.
// Loaded BEFORE overlay.js (see manifest) in the same shared content-script scope:
// exposes logVerdict(), startSession(), stopSession(), exportPDF() as globals for
// overlay.js, and uses overlay.js's escapeHtml() (available by the time these run).

const sessionLog = [];
const transcriptLog = [];
const keyPointsLog = [];
let sessionSummary = '';
let sessionStartTime = null;

// ── Surviving a page reload ───────────────────────────────────────────────────
// These arrays live in the PAGE, so a reload wipes them and the whole session is
// lost. A mirror copy is kept in browser.storage.local (which the reload doesn't
// touch): background.js re-sends START_FACTCHECK with the same sessionId and
// restoreSession() brings everything back.
const SESSION_BACKUP_KEY = 'sessionBackup';
let sessionId = null;
let persistTimer = null;

// Batched on purpose: a live transcript fires several times per second and every
// write serialises the whole session.
function persistSession() {
  if (sessionId === null || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (sessionId === null) return;
    browser.storage.local.set({
      [SESSION_BACKUP_KEY]: {
        sessionId,
        startTime: sessionStartTime,
        sessionLog,
        transcriptLog,
        keyPointsLog,
        summary: sessionSummary,
      },
    }).catch(() => {});
  }, 1500);
}

// Returns the recovered session (so the panel can re-render it) or null when the
// backup belongs to a different session — never restore someone else's transcript.
async function restoreSession(id) {
  let stored = null;
  try {
    stored = (await browser.storage.local.get(SESSION_BACKUP_KEY))[SESSION_BACKUP_KEY];
  } catch { return null; }
  if (!stored || stored.sessionId !== id) return null;

  sessionId = id;
  sessionStartTime = stored.startTime || Date.now();
  sessionSummary = stored.summary || '';
  sessionLog.length = 0;
  transcriptLog.length = 0;
  keyPointsLog.length = 0;
  (stored.sessionLog   || []).forEach(x => sessionLog.push(x));
  (stored.transcriptLog || []).forEach(x => transcriptLog.push(x));
  (stored.keyPointsLog  || []).forEach(x => keyPointsLog.push(x));

  return { transcript: transcriptLog, keyPoints: keyPointsLog, summary: sessionSummary };
}

function logVerdict(result) {
  sessionLog.push({
    timestamp: new Date().toISOString(),
    secondsElapsed: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0,
    clockTimestamp: result._timestamp || '',
    claim: result.claim,
    verdict: result.verdict,
    confidence: result.confidence,
    explanation: result.explanation,
    speakerConfidence: result.speaker_confidence,
    speakerExplanation: result.speaker_confidence_explanation,
    speakerName: result.speaker || null,
    sources: result.sources ?? [],
  });
  persistSession();
}

// Full session transcript, each line tagged with its clock timecode HH:MM:SS:FF.
function logTranscript(timecode, text, translation, speaker) {
  transcriptLog.push({ timecode, text, translation: translation || '', speaker: speaker || null });
  persistSession();
}

// A marker in the transcript flow: the active LLM model changed (fallback in the queue).
// `label` is the already-localized text (e.g. "Modelo activo: Cerebras").
function logModelChange(timecode, label) {
  transcriptLog.push({ timecode: timecode || '', modelChange: label || '' });
  persistSession();
}

// Neutral key points extracted live (verdict added later if the user verifies one).
function logKeyPoint(kp) {
  keyPointsLog.push({
    id: kp._id,
    timecode: kp._timestamp || '',
    category: kp.category || promptLang().catOther,
    point: kp.point,
    quote: kp.quote || '',
    speaker: kp.speaker || null,
    model: kp.model || '',
    verdict: '',
    verdictExplanation: '',
    sources: [],
  });
  persistSession();
}

// The user corrected a key point's text (✏️) — keep the export/summary in sync.
function updateKeyPointText(id, newText) {
  const entry = keyPointsLog.find(k => k.id === id);
  if (entry && newText && newText.trim()) { entry.point = newText.trim(); persistSession(); }
}

// The user put a name to a key point's speaker from its card (someone introduced
// themselves mid conference) — keep the export in sync.
function updateKeyPointSpeaker(id, name) {
  const entry = keyPointsLog.find(k => k.id === id);
  if (!entry || !name) return;
  entry.speaker = name;
  persistSession();
}

function updateKeyPointVerdict(id, result) {
  const entry = keyPointsLog.find(k => k.id === id);
  if (!entry || !result) return;
  entry.verdict = result.verdict || '';
  entry.confidence = result.confidence || '';
  entry.verdictExplanation = result.explanation || '';
  entry.sources = result.sources || [];
  persistSession();
}

// Compact input for the final summary: prefer the curated key points; fall back to
// the (capped) transcript if there are none yet.
function buildSummaryInput() {
  const title = document.title || '';
  if (keyPointsLog.length) {
    const lines = keyPointsLog.map(kp => {
      const spk = kp.speaker ? kp.speaker + ': ' : '';
      // The marker must match what summaryPrompt() tells the model to look for.
      const v = kp.verdict ? ' [' + promptLang().verifiedMarker + ': ' + kp.verdict + ']' : '';
      return '- [' + (kp.timecode || '') + '] ' + spk + kp.point + v;
    });
    return t('ex_title_label') + ' ' + title + '\n\n' + t('ex_kp_label') + '\n' + lines.join('\n');
  }
  // What was actually SAID — never the translations. The summary prompt already writes in
  // the UI language, and an AI translation can rewrite content: preferring translations
  // put a name the translator had invented straight into a summary. Model-change markers
  // have no text and used to be joined in as the literal word "undefined".
  const tr = transcriptLog.filter(x => !x.modelChange && x.text).map(x => x.text).join(' ');
  return t('ex_title_label') + ' ' + title + '\n\n' + t('ex_tr_label') + '\n' + tr.slice(0, 8000);
}

function setSummary(text) { sessionSummary = text || ''; persistSession(); }

// Is there anything worth saving? Used by the ✕ guard: an empty session closes without
// asking, one with content offers to export first.
function sessionHasContent() {
  return !!(sessionLog.length || transcriptLog.length || keyPointsLog.length || sessionSummary);
}

// Apply a participant rename to everything logged so the export stays consistent.
function updateSpeakerName(oldName, newName) {
  keyPointsLog.forEach(k => { if (k.speaker === oldName) k.speaker = newName; });
  transcriptLog.forEach(t => { if (t.speaker === oldName) t.speaker = newName; });
  persistSession();
}

// `id` comes from background.js and identifies this session across page reloads.
function startSession(id) {
  sessionLog.length = 0;
  transcriptLog.length = 0;
  keyPointsLog.length = 0;
  sessionSummary = '';
  sessionStartTime = Date.now();
  sessionId = (id === undefined || id === null) ? Date.now() : id;
  persistSession();
}

function stopSession() {
  sessionStartTime = null;
  // Cancel the pending write BEFORE clearing the id, or it would rewrite the backup
  // that background.js is deleting at this very moment.
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  sessionId = null;
}

function exportPDF() {
  if (!sessionLog.length && !transcriptLog.length && !keyPointsLog.length && !sessionSummary) {
    alert(t('ex_nothing'));
    return;
  }

  const pageTitle = document.title || 'NewsPal';
  const exportDate = new Date().toLocaleString();

  const verdictColor = (v, c) => {
    if (c === 'LOW') return '#b45309';
    if (v === 'TRUE') return '#15803d';
    if (v === 'SUBSTANTIALLY TRUE') return '#0d9488';
    if (v === 'FALSE') return '#b91c1c';
    if (v === 'MISLEADING') return '#b45309';
    return '#6b7280';
  };

  // group by speaker
  const speakerGroups = {};
  const speakerOrder  = [];
  sessionLog.forEach((entry, i) => {
    // filter out unresolved Speaker N labels — group under Unknown
    const rawSpk = entry.speakerName;
    const spk = (rawSpk && !rawSpk.match(/^Speaker\s*\d+$/i) && rawSpk !== 'Other')
      ? rawSpk
      : 'Unknown';
    if (!speakerGroups[spk]) { speakerGroups[spk] = []; speakerOrder.push(spk); }
    speakerGroups[spk].push({ entry, i });
  });

  const speakerColors = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#f97316'];

  const claimsHTML = speakerOrder.map((spk, spkIdx) => {
    const color = spk !== 'Other' ? speakerColors[spkIdx % speakerColors.length] : '#888';
    const headerHTML = '<div class="speaker-section-header" style="border-left:3px solid ' + color + '">' +
      '<span class="speaker-section-name" style="color:' + color + '">' + escapeHtml(spk) + '</span>' +
      '<span class="speaker-section-count">' + speakerGroups[spk].length + ' claim' + (speakerGroups[spk].length !== 1 ? 's' : '') + '</span>' +
    '</div>';

    const cardsHTML = speakerGroups[spk].map(({ entry, i }) => {
      const minutes = Math.floor(entry.secondsElapsed / 60);
      const seconds = entry.secondsElapsed % 60;
      const timestamp = entry.clockTimestamp ||
        (String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'));
      const vcolor = verdictColor(entry.verdict, entry.confidence);

      const sourcesHTML = entry.sources.length
        ? '<div class="sources"><span class="sources-label">Sources:</span>' +
          entry.sources.map((url, j) =>
            '<a href="' + escapeHtml(url) + '" class="source-link">Source ' + (j + 1) + '</a>'
          ).join('') + '</div>'
        : '';

      return '<div class="claim-card">' +
        '<div class="claim-header">' +
          '<span class="claim-number">#' + (i + 1) + '</span>' +
          '<span class="verdict" style="color:' + vcolor + '">' + escapeHtml(entry.verdict) + '</span>' +
          '<span class="confidence">' + escapeHtml(entry.confidence) + ' certainty</span>' +
          '<span class="timestamp">' + escapeHtml(timestamp) + '</span>' +
        '</div>' +
        '<div class="claim-text">"' + escapeHtml(entry.claim) + '"</div>' +
        '<div class="explanation">' + escapeHtml(entry.explanation) + '</div>' +
        '<div class="speaker-row"><span class="speaker-label">Speaker conviction:</span> ' +
          escapeHtml(entry.speakerConfidence || 'N/A') +
        '</div>' +
        sourcesHTML +
      '</div>';
    }).join('');

    return headerHTML + cardsHTML;
  }).join('');

  // Category/verdict labels come from lang.js (KP_CATEGORY_META, verdictLabel):
  // one bilingual copy shared with the overlay, both languages' codes recognised.
  // Consistent colour per speaker name across key points and the transcript.
  const spkColorMap = {};
  const speakerColor = (name) => {
    if (!name) return '#444';
    if (!spkColorMap[name]) spkColorMap[name] = speakerColors[Object.keys(spkColorMap).length % speakerColors.length];
    return spkColorMap[name];
  };
  const keyPointsHTML = keyPointsLog.length
    ? '<div class="claims-title">' + escapeHtml(t('ex_keypoints')) + ' (' + keyPointsLog.length + ')</div>' +
      keyPointsLog.map(kp => {
        const cat = (kp.category || promptLang().catOther).toUpperCase();
        const catMeta = KP_CATEGORY_META[cat];
        const label = catMeta ? catMeta.label : (cat.charAt(0) + cat.slice(1).toLowerCase());
        const catColor = catMeta ? catMeta.color : '#64748b';
        const spk = kp.speaker ? '<span class="kp-speaker" style="color:' + speakerColor(kp.speaker) + '">' + escapeHtml(kp.speaker) + '</span>' : '';
        const modelTag = kp.model
          ? '<span class="kp-model">' + escapeHtml(t('ov_via') + ' ' + providerLabel(kp.model)) + '</span>'
          : '';
        const quote = kp.quote ? '<div class="kp-quote">“' + escapeHtml(kp.quote) + '”</div>' : '';
        let verdict = '';
        if (kp.verdict) {
          const vc = verdictColor(kp.verdict, kp.confidence);
          const vsources = (kp.sources && kp.sources.length)
            ? ' ' + kp.sources.map((u, i) => '<a href="' + escapeHtml(u) + '" class="source-link">' + escapeHtml(t('ex_source')) + ' ' + (i + 1) + '</a>').join(' ')
            : '';
          verdict = '<div class="kp-verdict">' +
            '<span class="kp-verdict-badge" style="color:' + vc + '">' + escapeHtml(verdictLabel(kp.verdict)) + '</span> ' +
            escapeHtml(kp.verdictExplanation || '') + vsources +
          '</div>';
        }
        return '<div class="kp-card">' +
          '<div class="kp-header">' +
            '<span class="kp-cat" style="color:' + catColor + '">' + escapeHtml(label) + '</span>' +
            spk + modelTag +
            '<span class="timestamp">' + escapeHtml(kp.timecode || '') + '</span>' +
          '</div>' +
          '<div class="kp-point">' + escapeHtml(kp.point) + '</div>' +
          quote +
          verdict +
        '</div>';
      }).join('')
    : '';

  const summaryHTML = sessionSummary
    ? '<div class="summary-box"><div class="summary-box-title">' + escapeHtml(t('ex_summary')) + '</div>' +
      '<div class="summary-box-text">' + escapeHtml(sessionSummary) + '</div></div>'
    : '';

  let trLastSpk = null;
  const transcriptHTML = transcriptLog.length
    ? '<div class="claims-title">' + escapeHtml(t('ex_transcript')) + ' (' + transcriptLog.filter(x => !x.modelChange).length + ')</div>' +
      '<div class="transcript">' +
        transcriptLog.map(t => {
          // Model-change marker (not a spoken line): render inline in the flow.
          if (t.modelChange) {
            return '<div class="transcript-model">— ' + escapeHtml(t.modelChange) +
              (t.timecode ? ' [' + escapeHtml(t.timecode) + ']' : '') + ' —</div>';
          }
          let spkHTML = '';
          if (t.speaker && t.speaker !== trLastSpk) {
            trLastSpk = t.speaker;
            spkHTML = '<div class="transcript-speaker" style="color:' + speakerColor(t.speaker) + '">' + escapeHtml(t.speaker) + '</div>';
          }
          const tr = (t.translation && t.translation.trim() && t.translation.trim() !== (t.text || '').trim())
            ? '<div class="transcript-tr">↳ ' + escapeHtml(t.translation) + '</div>'
            : '';
          return spkHTML + '<div class="transcript-line">' +
            '<span class="transcript-tc">[' + escapeHtml(t.timecode) + ']</span> ' +
            escapeHtml(t.text) + tr +
          '</div>';
        }).join('') +
      '</div>'
    : '';

  const trueCount = sessionLog.filter(e => e.verdict === 'TRUE').length;
  const subTrueCount = sessionLog.filter(e => e.verdict === 'SUBSTANTIALLY TRUE').length;
  const falseCount = sessionLog.filter(e => e.verdict === 'FALSE').length;
  const misleadingCount = sessionLog.filter(e => e.verdict === 'MISLEADING').length;
  const unverifiableCount = sessionLog.filter(e => e.verdict === 'UNVERIFIABLE').length;

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/>' +
    '<title>NewsPal — ' + escapeHtml(pageTitle) + '</title><style>' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #111; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.5; }' +
    '.report-header { border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 24px; }' +
    '.report-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }' +
    '.report-meta { font-size: 11px; color: #666; }' +
    '.report-meta span { margin-right: 16px; }' +
    '.summary { display: flex; gap: 16px; margin-bottom: 28px; padding: 16px; background: #f8f8f8; border-radius: 8px; }' +
    '.summary-item { display: flex; flex-direction: column; align-items: center; flex: 1; }' +
    '.summary-count { font-size: 24px; font-weight: 700; }' +
    '.summary-count.true { color: #15803d; } .summary-count.subtrue { color: #0d9488; } .summary-count.false { color: #b91c1c; } .summary-count.misleading { color: #b45309; } .summary-count.unverifiable { color: #6b7280; }' +
    '.summary-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-top: 2px; }' +
    '.claims-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 12px; }' +
    '.claim-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; page-break-inside: avoid; }' +
    '.claim-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }' +
    '.claim-number { font-size: 10px; color: #aaa; font-weight: 600; }' +
    '.verdict { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }' +
    '.confidence { font-size: 10px; color: #888; }' +
    '.timestamp { font-size: 10px; color: #aaa; margin-left: auto; }' +
    '.claim-text { font-size: 13px; font-style: italic; color: #333; margin-bottom: 6px; }' +
    '.explanation { font-size: 12px; color: #555; margin-bottom: 6px; }' +
    '.speaker-row { font-size: 11px; color: #888; margin-bottom: 4px; }' +
    '.speaker-label { font-weight: 600; }' +
    '.sources { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }' +
    '.sources-label { font-size: 10px; color: #aaa; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }' +
    '.source-link { font-size: 10px; color: #1d4ed8; text-decoration: none; }' +
    '.speaker-section-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 20px 0 8px; background: #f8f8f8; border-radius: 6px; }' +
    '.speaker-section-name { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }' +
    '.speaker-section-count { font-size: 11px; color: #888; margin-left: auto; }' +
    '.summary-box { border: 1px solid #d4d4d4; background: #fafafa; border-radius: 8px; padding: 16px 18px; margin-bottom: 24px; }' +
    '.summary-box-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin-bottom: 8px; }' +
    '.summary-box-text { font-size: 13px; color: #222; line-height: 1.6; white-space: pre-wrap; }' +
    '.kp-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; page-break-inside: avoid; }' +
    '.kp-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }' +
    '.kp-cat { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #1d4ed8; }' +
    '.kp-speaker { font-size: 11px; font-weight: 600; color: #444; }' +
    '.kp-model { font-size: 10px; font-weight: 600; color: #7c3aed; }' +
    '.kp-point { font-size: 13px; color: #222; margin-bottom: 4px; }' +
    '.kp-quote { font-size: 12px; font-style: italic; color: #666; }' +
    '.kp-verdict { font-size: 12px; color: #444; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e5e5e5; }' +
    '.kp-verdict-badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }' +
    '.transcript { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; margin-top: 8px; }' +
    '.transcript-line { font-size: 12px; color: #333; line-height: 1.6; margin-bottom: 2px; }' +
    '.transcript-tc { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; color: #b45309; }' +
    '.transcript-tr { margin-left: 16px; color: #1d4ed8; font-size: 12px; line-height: 1.5; }' +
    '.transcript-speaker { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin: 8px 0 2px; }' +
    '.transcript-model { font-size: 10px; font-weight: 700; color: #7c3aed; text-align: center; margin: 8px 0; letter-spacing: 0.03em; }' +
    '@media print { body { padding: 20px; } .claim-card { page-break-inside: avoid; } }' +
    '</style></head><body>' +
    '<div class="report-header">' +
      '<div class="report-title">NewsPal — ' + escapeHtml(t('ex_report')) + '</div>' +
      '<div class="report-meta">' +
        '<span>📺 ' + escapeHtml(pageTitle) + '</span>' +
        '<span>🕐 ' + escapeHtml(exportDate) + '</span>' +
        '<span>📋 ' + sessionLog.length + ' claim' + (sessionLog.length !== 1 ? 's' : '') + ' detected</span>' +
      '</div>' +
    '</div>' +
    summaryHTML +
    keyPointsHTML +
    (sessionLog.length
      ? '<div class="summary">' +
          '<div class="summary-item"><span class="summary-count true">' + trueCount + '</span><span class="summary-label">True</span></div>' +
          '<div class="summary-item"><span class="summary-count subtrue">' + subTrueCount + '</span><span class="summary-label">Substantially True</span></div>' +
          '<div class="summary-item"><span class="summary-count false">' + falseCount + '</span><span class="summary-label">False</span></div>' +
          '<div class="summary-item"><span class="summary-count misleading">' + misleadingCount + '</span><span class="summary-label">Misleading</span></div>' +
          '<div class="summary-item"><span class="summary-count unverifiable">' + unverifiableCount + '</span><span class="summary-label">Unverifiable</span></div>' +
        '</div>' +
        '<div class="claims-title">' + escapeHtml(t('ex_verified')) + ' (' + sessionLog.length + ')</div>' +
        claimsHTML
      : '') +
    transcriptHTML +
    '</body></html>';

  // window.open is blocked in extensions — use blob URL instead
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const safeTitle = (pageTitle || 'newspal')
    .replace(/[^\w\sáéíóúüñÁÉÍÓÚÜÑ-]/g, '')
    .trim().replace(/\s+/g, '-').slice(0, 60) || 'newspal';
  a.download = safeTitle + '-' + new Date().toISOString().slice(0, 10) + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}