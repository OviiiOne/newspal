// overlay.js

console.log('[overlay] content script loaded');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let panel = null;
let transcriptFeedEl = null;
let interimEl = null;
let claimFeedEl = null;
let verdictListEl = null;
let summaryEl = null;
let interestingBtn = null;
let participantNames = [];
let transcriptCollapsed = false;
const pendingCards    = new Map();
const pendingCardTimes = new Map();

// expire pending cards after 90 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of pendingCardTimes) {
    if (now - time > 90000) {
      const card = pendingCards.get(key);
      if (card) {
        card.classList.remove('rtfc-verdict--pending');
        const verifying = card.querySelector('.rtfc-verifying');
        if (verifying) verifying.textContent = '⚠ unverified';
      }
      pendingCards.delete(key);
      pendingCardTimes.delete(key);
    }
  }
}, 15000);

let lastTranscriptTimestamp = '';
const sentenceTimestamps   = [];
const MAX_TIMESTAMP_BUFFER = 10;

// ── Speaker state ────────────────────────────────────────────────────────────
let speakers = [];

// ── Speaker colors ────────────────────────────────────────────────────────────
const SPEAKER_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#f97316',
];
const speakerColorMap = new Map();

function getSpeakerColor(name) {
  if (!speakerColorMap.has(name)) {
    const idx = speakerColorMap.size % SPEAKER_COLORS.length;
    speakerColorMap.set(name, SPEAKER_COLORS[idx]);
  }
  return speakerColorMap.get(name);
}

// ── Speaker parsing ───────────────────────────────────────────────────────────
function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  // only match capitalized proper names (not lowercase words like "in", "the", etc.)
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

let lastActiveSpeaker = null; // track most recently labeled speaker

function normalizeSpeakerName(name) {
  if (!name) return name;
  // if name matches a known speaker's last name or full name, return the canonical last name
  for (const speaker of speakers) {
    const lastName = speaker.trim().split(' ').pop().toLowerCase();
    if (name.toLowerCase() === speaker.toLowerCase()) return speaker; // exact match
    if (name.toLowerCase().includes(lastName)) return speaker;        // last name match
  }
  return name; // unknown speaker — return as-is
}

function getClaimSpeaker(claimText) {
  if (!speakers.length) return 'Other';
  const lower = claimText.toLowerCase();

  // direct name match
  for (const speaker of speakers) {
    if (lower.includes(speaker.toLowerCase())) return speaker;
  }

  // partial name match (handles "Vice President Harris" → "Harris")
  for (const speaker of speakers) {
    const parts = speaker.toLowerCase().split(' ');
    if (parts.some(p => p.length > 3 && lower.includes(p))) return speaker;
  }

  // fallback: use last active speaker for vague references
  if (lastActiveSpeaker) return lastActiveSpeaker;

  return 'Other';
}

// ── Speaker ID confirmation ──────────────────────────────────────────────────

const confirmedSpeakerMap = {}; // { speakerId: 'Harris' }
const pendingSpeakerIds   = new Set(); // IDs waiting for confirmation

function showSpeakerBanner(speakerId, sample) {
  if (pendingSpeakerIds.has(speakerId)) return;
  if (speakerId in confirmedSpeakerMap) return;
  // if speakers not yet parsed from title, retry once after 1s
  if (!speakers.length) {
    setTimeout(() => showSpeakerBanner(speakerId, sample), 1000);
    return;
  }
  pendingSpeakerIds.add(speakerId);

  const banner = document.createElement('div');
  banner.className = 'rtfc-speaker-banner';
  banner.innerHTML =
    '<div class="rtfc-speaker-banner-text">New speaker detected — who is this?</div>' +
    '<div class="rtfc-speaker-banner-sample">"' + escapeHtml(sample) + '..."</div>' +
    '<div class="rtfc-speaker-banner-buttons">' +
      speakers.map(name =>
        '<button class="rtfc-speaker-banner-btn" data-name="' + escapeHtml(name) + '" data-id="' + speakerId + '">' + escapeHtml(name) + '</button>'
      ).join('') +
      '<button class="rtfc-speaker-banner-btn rtfc-speaker-banner-btn--skip" data-id="' + speakerId + '">Skip</button>' +
    '</div>';

  banner.querySelectorAll('.rtfc-speaker-banner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const id   = parseInt(btn.dataset.id);
      if (name) {
        confirmedSpeakerMap[id] = name;
        browser.runtime.sendMessage({
          type: 'SPEAKER_NAMES',
          speakerIdToName: { [id]: name },
        });
      }
      pendingSpeakerIds.delete(id);
      if (!name) confirmedSpeakerMap[id] = null;
      banner.remove();
      // retroactively tag all existing grounded cards now that we have more info
      retryTagAllCards();
    });
  });

  // insert above verdicts
  const verdictsSection = panel?.querySelector('#rtfc-verdicts-section');
  if (verdictsSection) verdictsSection.insertAdjacentElement('beforebegin', banner);
}

// ── Speaker confirmation state ───────────────────────────────────────────────

function allSpeakersConfirmed() {
  // true when every speaker seen so far has been confirmed or skipped
  // and at least one real name has been confirmed
  const confirmedNames = Object.values(confirmedSpeakerMap).filter(v => v !== null);
  return confirmedNames.length >= Math.min(speakers.length, Object.keys(confirmedSpeakerMap).length)
    && Object.keys(confirmedSpeakerMap).length > 0;
}

function retryTagAllCards() {
  // retroactively tag all grounded cards once speakers are confirmed
  if (!verdictListEl) return;
  verdictListEl.querySelectorAll('.rtfc-verdict:not(.rtfc-verdict--pending)').forEach(card => {
    const sid = card.dataset.speakerid;
    if (sid === undefined) return;
    const rawName = confirmedSpeakerMap[sid];
    if (!rawName) return; // skipped or not confirmed
    const name = normalizeSpeakerName(rawName);
    // add or update tag
    let tag = card.querySelector('.rtfc-speaker-tag');
    if (tag) {
      tag.textContent = name;
      tag.style.background = getSpeakerColor(name);
    } else {
      const color = getSpeakerColor(name);
      tag = document.createElement('div');
      tag.className = 'rtfc-speaker-tag';
      tag.style.background = color;
      tag.textContent = name;
      card.insertBefore(tag, card.firstChild);
    }
  });
}

// ── Speaker editor ───────────────────────────────────────────────────────────

function sendSpeakerMap() {
  // Deepgram speaker IDs are assigned in order of first appearance
  // We map ID 0 → speakers[0], ID 1 → speakers[1], etc.
  const speakerIdToName = {};
  speakers.forEach((name, i) => { speakerIdToName[i] = name; });
  browser.runtime.sendMessage({ type: 'SPEAKER_NAMES', speakerIdToName });
}

// Typing inside the panel must not reach the page. The player's own keyboard shortcuts
// listen on the document, so Enter or a space typed in one of our fields paused the
// press conference. Our own listeners on the field still run: this only stops the event
// on its way out of the panel.
function keepKeysInPanel(el) {
  ['keydown', 'keyup', 'keypress'].forEach(type => el.addEventListener(type, e => e.stopPropagation()));
}

function renderSpeakerEditor() {
  const el = panel?.querySelector('#rtfc-speaker-editor');
  if (!el || !speakers.length) return;

  el.innerHTML = speakers.map((name, i) => {
    const color = getSpeakerColor(name);
    return '<span class="rtfc-speaker-chip" style="border-color:' + color + ';color:' + color + '" data-idx="' + i + '">' +
      '<input class="rtfc-speaker-chip-input" value="' + escapeHtml(name) + '" data-idx="' + i + '" style="color:' + color + '" />' +
    '</span>';
  }).join('');

  el.querySelectorAll('.rtfc-speaker-chip-input').forEach(input => {
    keepKeysInPanel(input);
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const oldName = speakers[idx];
      const newName = e.target.value.trim() || oldName;
      if (newName === oldName) return;

      // update color map
      if (speakerColorMap.has(oldName)) {
        speakerColorMap.set(newName, speakerColorMap.get(oldName));
        speakerColorMap.delete(oldName);
      }

      speakers[idx] = newName;
      e.target.style.color = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.borderColor = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.color = getSpeakerColor(newName);
      sendSpeakerMap(); // update service worker with new names

      // re-render all verdict cards to update speaker tags
      const cards = verdictListEl?.querySelectorAll('.rtfc-speaker-tag');
      if (cards) {
        cards.forEach(tag => {
          if (tag.textContent === oldName) {
            tag.textContent = newName;
            tag.style.background = getSpeakerColor(newName);
          }
        });
      }
    });
    // select all on focus for easy editing
    input.addEventListener('focus', e => e.target.select());
  });
}

// ── Error toast ──────────────────────────────────────────────────────────────

function showError(message, level) {
  if (!panel) return;
  const isInfo = level === 'info';
  const existing = panel.querySelector('.rtfc-error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'rtfc-error-toast' + (isInfo ? ' rtfc-error-toast--info' : '');
  toast.innerHTML =
    '<span class="rtfc-error-icon">' + (isInfo ? 'ℹ' : '⚠') + '</span>' +
    '<span class="rtfc-error-msg">' + escapeHtml(message) + '</span>' +
    '<button class="rtfc-error-close">✕</button>';

  toast.querySelector('.rtfc-error-close').addEventListener('click', () => toast.remove());
  panel.querySelector('#rtfc-header').insertAdjacentElement('afterend', toast);

  // Info auto-dismisses; errors stay until replaced or closed, so failures get noticed.
  if (isInfo) setTimeout(() => toast.remove(), 5000);
}

// The header dot reflects real state so failures are noticeable even after a toast
// fades: amber = connecting, green = audio flowing, red = error.
let currentDotState = '';

function setDotState(state) {
  const dot = panel && panel.querySelector('.rtfc-dot');
  if (!dot) return;
  if (state === currentDotState) return; // only react to a real change
  currentDotState = state;
  dot.classList.remove('rtfc-dot--ready', 'rtfc-dot--live', 'rtfc-dot--error');
  if (state === 'ready') dot.classList.add('rtfc-dot--ready');
  else if (state === 'live') dot.classList.add('rtfc-dot--live');
  else if (state === 'error') dot.classList.add('rtfc-dot--error');
  flashHeader(state);
}

// Flash the whole header ~5 times in the new colour so the change is easy to catch.
function flashHeader(state) {
  const header = panel && panel.querySelector('#rtfc-header');
  if (!header) return;
  const cls = state === 'ready' ? 'rtfc-header-flash--ready'
            : state === 'live' ? 'rtfc-header-flash--live'
            : state === 'error' ? 'rtfc-header-flash--error'
            : 'rtfc-header-flash--connecting';
  header.classList.remove('rtfc-header-flash--connecting', 'rtfc-header-flash--ready', 'rtfc-header-flash--live', 'rtfc-header-flash--error');
  void header.offsetWidth; // restart the animation if the same class was just used
  header.classList.add(cls);
  setTimeout(() => header.classList.remove(cls), 2200);
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function createPanel() {
  if (panel) return;

  panel = document.createElement('div');
  panel.id = 'rtfc-panel';
  panel.innerHTML = [
    '<div id="rtfc-header">',
      '<span><span class="rtfc-dot"></span>NewsPal</span>',
      '<div class="rtfc-header-actions">',
        '<button id="rtfc-summary-btn" title="' + escapeHtml(t('ov_summary_btn_title')) + '">' + escapeHtml(t('ov_summary_btn')) + '</button>',
        '<button id="rtfc-export" title="' + escapeHtml(t('ov_export_title')) + '">' + escapeHtml(t('ov_export_btn')) + '</button>',
        '<button id="rtfc-close">✕</button>',
      '</div>',
    '</div>',
    '<div id="rtfc-body">',
      '<div id="rtfc-participants"></div>',
      '<div id="rtfc-summary" style="display:none"></div>',
      '<div id="rtfc-transcript-section">',
        '<div class="rtfc-section-header">',
          '<span class="rtfc-section-label">' + escapeHtml(t('ov_transcript')) + '</span>',
          '<button class="rtfc-toggle-btn" id="rtfc-transcript-toggle">▾</button>',
        '</div>',
        '<div id="rtfc-transcript-feed"></div>',
        '<p id="rtfc-interim"></p>',
      '</div>',
      '<div id="rtfc-verdicts-section">',
        '<div class="rtfc-section-header">',
          '<span class="rtfc-section-label">' + escapeHtml(t('ov_keypoints')) + '</span>',
          '<div id="rtfc-speaker-editor"></div>',
        '</div>',
        '<div id="rtfc-verdicts">',
          '<p class="rtfc-empty">' + escapeHtml(t('ov_empty')) + '</p>',
        '</div>',
      '</div>',
    '</div>',
    '<div id="rtfc-footer">NewsPal v' + escapeHtml(browser.runtime.getManifest().version) + '</div>',
  ].join('');

  document.body.appendChild(panel);

  transcriptFeedEl = panel.querySelector('#rtfc-transcript-feed');
  interimEl        = panel.querySelector('#rtfc-interim');
  claimFeedEl      = panel.querySelector('#rtfc-claim-feed');
  verdictListEl    = panel.querySelector('#rtfc-verdicts');
  summaryEl        = panel.querySelector('#rtfc-summary');

  // The footer starts with the plain version and gets the β suffix (unsigned build)
  // from the background, which is the only context that can read installType.
  const footerEl = panel.querySelector('#rtfc-footer');
  if (footerEl) {
    browser.runtime.sendMessage({ type: 'GET_VERSION_LABEL' })
      .then(res => { if (res && res.label) footerEl.textContent = 'NewsPal ' + res.label; })
      .catch(() => {});
  }

  panel.querySelector('#rtfc-close').addEventListener('click', () => requestCloseSession());

  panel.querySelector('#rtfc-export').addEventListener('click', () => exportPDF());
  panel.querySelector('#rtfc-summary-btn').addEventListener('click', () => generateSummary());

  setupInterestingButton();
  renderParticipantsBar();
  makeDraggable(panel);
  makeResizable(panel);

  panel.querySelector('#rtfc-transcript-toggle').addEventListener('click', () => {
    transcriptCollapsed = !transcriptCollapsed;
    transcriptFeedEl.style.display = transcriptCollapsed ? 'none' : '';
    interimEl.style.display = transcriptCollapsed ? 'none' : '';
    panel.querySelector('#rtfc-transcript-toggle').textContent = transcriptCollapsed ? '▸' : '▾';
  });
}

function removePanel() {
  panel?.remove();
  panel = null;
  transcriptFeedEl = null;
  interimEl = null;
  claimFeedEl = null;
  verdictListEl = null;
  summaryEl = null;
  transcriptCollapsed = false;
  pendingCards.clear();
  pendingCardTimes.clear();
  kpCards.clear();
  kpCounter = 0;
  currentDotState = '';
  lastTranscriptSpeaker = null;
  if (interestingBtn) { interestingBtn.remove(); interestingBtn = null; }
  participantNames = [];
  speakers = [];
  speakerColorMap.clear();
  sentenceTimestamps.length = 0;
  lastTranscriptTimestamp = '';
  lastActiveSpeaker = null;
  Object.keys(confirmedSpeakerMap).forEach(k => delete confirmedSpeakerMap[k]);
  pendingSpeakerIds.clear();
}

// ── Closing the session ───────────────────────────────────────────────────────
// The ✕ throws away the whole session (the transcript only lives here), so a stray
// click used to be unrecoverable. Ask first, and offer to take the work out on the
// way: export as it is, or generate the summary and export that.

let closeConfirmEl = null;
let closeAfterSummary = false;   // waiting for SUMMARY_RESULT before exporting+closing
let closeSummaryTimer = null;

function closeSession() {
  dismissCloseConfirm();
  browser.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
  removePanel();
}

function requestCloseSession() {
  // An empty session has nothing to lose — don't nag.
  if (typeof sessionHasContent === 'function' && !sessionHasContent()) { closeSession(); return; }
  if (closeConfirmEl) return;
  showCloseConfirm();
}

function dismissCloseConfirm() {
  if (closeSummaryTimer) { clearTimeout(closeSummaryTimer); closeSummaryTimer = null; }
  closeAfterSummary = false;
  document.removeEventListener('keydown', onCloseConfirmKey, true);
  closeConfirmEl?.remove();
  closeConfirmEl = null;
}

function onCloseConfirmKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); dismissCloseConfirm(); }
}

function showCloseConfirm() {
  if (!panel) return;
  closeConfirmEl = document.createElement('div');
  closeConfirmEl.className = 'rtfc-confirm';
  closeConfirmEl.innerHTML = [
    '<div class="rtfc-confirm-box">',
      '<p class="rtfc-confirm-title">' + escapeHtml(t('ov_close_title')) + '</p>',
      '<p class="rtfc-confirm-text">' + escapeHtml(t('ov_close_text')) + '</p>',
      '<button class="rtfc-confirm-btn rtfc-confirm-primary" data-act="summary">' + escapeHtml(t('ov_close_summary_export')) + '</button>',
      '<button class="rtfc-confirm-btn" data-act="export">' + escapeHtml(t('ov_close_export')) + '</button>',
      '<button class="rtfc-confirm-btn rtfc-confirm-danger" data-act="discard">' + escapeHtml(t('ov_close_discard')) + '</button>',
      '<button class="rtfc-confirm-btn rtfc-confirm-cancel" data-act="cancel">' + escapeHtml(t('ov_cancel')) + '</button>',
      '<p class="rtfc-confirm-status"></p>',
    '</div>',
  ].join('');
  panel.appendChild(closeConfirmEl);

  // Clicking the dark backdrop is a cancel, like Escape.
  closeConfirmEl.addEventListener('click', (e) => {
    if (e.target === closeConfirmEl) dismissCloseConfirm();
  });
  document.addEventListener('keydown', onCloseConfirmKey, true);

  closeConfirmEl.querySelectorAll('.rtfc-confirm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.act) {
        case 'cancel':  dismissCloseConfirm(); break;
        case 'discard': closeSession(); break;
        case 'export':  exportPDF(); closeSession(); break;
        case 'summary': startCloseWithSummary(); break;
      }
    });
  });
}

// Generate the summary first, then export and close. The summary is an AI call, so we
// wait for SUMMARY_RESULT — and export anyway if it never arrives, rather than trap the
// user in a dialog with their whole session inside.
function startCloseWithSummary() {
  if (!closeConfirmEl) return;
  const already = (typeof sessionSummary === 'string') ? sessionSummary.trim() : '';
  if (already) { exportPDF(); closeSession(); return; }

  closeConfirmEl.querySelectorAll('.rtfc-confirm-btn').forEach(b => {
    if (b.dataset.act !== 'cancel') b.disabled = true;
  });
  const status = closeConfirmEl.querySelector('.rtfc-confirm-status');
  if (status) status.textContent = t('ov_close_summarizing');
  closeAfterSummary = true;
  generateSummary();
  closeSummaryTimer = setTimeout(() => finishCloseWithSummary(), 90000);
}

function finishCloseWithSummary() {
  if (!closeAfterSummary) return;
  closeAfterSummary = false;
  exportPDF();
  closeSession();
}

// ── Transcript ────────────────────────────────────────────────────────────────

// Computer-clock timecode HH:MM:SS:FF (FF = frame, 24 fps) at the moment the
// sentence was finalized — lets the user know the real-world time something was said.
function getClockTimecode() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

let lastTranscriptSpeaker = null;

// The "↳ translation" sub-line. An AI translation gets its own colour and a small badge,
// because unlike Google it can rewrite what was said (it once swapped a name). The badge
// label lives in a pseudo-element via data-label, so it is never part of a text selection
// and can't leak into a ⭐ fragment or a copy-paste.
// A later call replaces the sub-line: Google's version supersedes a provisional AI one,
// and an empty translation removes it (a provisional version taken back).
function setLineTranslation(line, text, translation, source) {
  let tr = line.querySelector('.rtfc-tr');
  if (!translation || !translation.trim() || translation.trim() === text.trim()) {
    if (tr) tr.remove();
    return;
  }
  if (!tr) {
    tr = document.createElement('div');
    line.appendChild(tr);
  }
  tr.className = 'rtfc-tr' + (source === 'ai' ? ' rtfc-tr-ai' : '');
  tr.title = translationEngineTitle(source);
  tr.textContent = '↳ ';
  if (source === 'ai') {
    const badge = document.createElement('span');
    badge.className = 'rtfc-ai-badge';
    badge.dataset.label = t('ov_ai_badge');
    badge.title = t('ov_ai_badge_title');
    tr.appendChild(badge);
  }
  tr.appendChild(document.createTextNode(translation));
}

// Which engine produced a translation, shown on hover ('gladia' | 'google' | 'ai').
// Lines restored from an older backup have no source recorded: no title then.
function translationEngineTitle(source) {
  if (source === 'gladia') return t('ov_tr_by_gladia');
  if (source === 'google') return t('ov_tr_by_google');
  if (source === 'ai') return t('ov_ai_badge_title');
  return '';
}

// A translation arriving after its line is already on screen.
function applyLateTranslation(lineId, translation, source) {
  if (!transcriptFeedEl || !lineId) return;
  const line = transcriptFeedEl.querySelector('.rtfc-transcript-line[data-line-id="' + CSS.escape(lineId) + '"]');
  if (!line) return; // the line was cleared, or restored without an id
  // Same courtesy as new lines: only keep following the feed if the user already was.
  const atBottom = transcriptFeedEl.scrollHeight - transcriptFeedEl.scrollTop - transcriptFeedEl.clientHeight < 28;
  setLineTranslation(line, line.dataset.text || '', translation, source);
  if (atBottom) transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function addTranscriptLine(timecode, text, translation, speaker, lineId, translationSource) {
  if (!transcriptFeedEl) return;
  // Only auto-scroll to the newest line if the user is already at the bottom AND
  // isn't selecting text here. Otherwise leave the view where it is, so they can
  // scroll up and select older lines (to ⭐ mark them) without it jumping away.
  const distanceFromBottom =
    transcriptFeedEl.scrollHeight - transcriptFeedEl.scrollTop - transcriptFeedEl.clientHeight;
  const atBottom = distanceFromBottom < 28;
  const sel = window.getSelection();
  const selectingHere = sel && !sel.isCollapsed && sel.anchorNode &&
    transcriptFeedEl.contains(sel.anchorNode);
  const shouldStick = atBottom && !selectingHere;
  // Show the speaker name at the start and whenever it changes.
  if (speaker && speaker !== lastTranscriptSpeaker) {
    lastTranscriptSpeaker = speaker;
    const sp = document.createElement('div');
    sp.className = 'rtfc-tr-speaker';
    sp.textContent = speaker;
    transcriptFeedEl.appendChild(sp);
  }
  const line = document.createElement('div');
  line.className = 'rtfc-transcript-line';
  if (lineId) line.dataset.lineId = lineId;
  line.dataset.text = text;
  const tc = document.createElement('span');
  tc.className = 'rtfc-tc';
  tc.textContent = '[' + timecode + ']';
  line.appendChild(tc);
  line.appendChild(document.createTextNode(' ' + text));
  setLineTranslation(line, text, translation, translationSource);
  transcriptFeedEl.appendChild(line);
  if (shouldStick) transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

// Marker line in the live transcript feed noting the active model changed. Sticks to the
// bottom only if the user is already there (same courtesy as addTranscriptLine).
function addModelMarker(label) {
  if (!transcriptFeedEl) return;
  const distanceFromBottom =
    transcriptFeedEl.scrollHeight - transcriptFeedEl.scrollTop - transcriptFeedEl.clientHeight;
  const atBottom = distanceFromBottom < 28;
  const line = document.createElement('div');
  line.className = 'rtfc-tr-model';
  line.textContent = '— ' + label + ' —';
  transcriptFeedEl.appendChild(line);
  if (atBottom) transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function updateInterim(text) {
  if (!interimEl) return;
  interimEl.textContent = text;
}

function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
}

// ── Claims ────────────────────────────────────────────────────────────────────
function addClaimBullet(claim) {
  if (!claimFeedEl) return;
  const li = document.createElement('li');
  li.className = 'rtfc-claim-bullet rtfc-claim-bullet--pending';
  li.dataset.claim = claim.toLowerCase().slice(0, 40);
  li.textContent = claim;
  claimFeedEl.appendChild(li);
  return li;
}

function applyVerdictToBullet(claim, verdict, confidence) {
  if (!claimFeedEl) return;
  const color = colorForVerdict(verdict, confidence);
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  const bullets = claimFeedEl.querySelectorAll('.rtfc-claim-bullet');
  let bestLi = null, bestScore = 0;
  for (const li of bullets) {
    const bulletWords = (li.textContent || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = bulletWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, bulletWords.length);
    if (score > bestScore) { bestScore = score; bestLi = li; }
  }
  if (bestLi && bestScore >= 0.3) {
    bestLi.className = 'rtfc-claim-bullet rtfc-claim-bullet--' + color;
  }
}

// ── Verdicts ──────────────────────────────────────────────────────────────────
function colorForVerdict(verdict, confidence) {
  if (confidence === 'LOW')              return 'yellow';
  if (verdict === 'TRUE')                return 'green';
  if (verdict === 'SUBSTANTIALLY TRUE')  return 'teal';
  if (verdict === 'FALSE')               return 'red';
  if (verdict === 'MISLEADING')          return 'yellow';
  if (verdict === 'UNVERIFIABLE')        return 'grey';
  return 'grey';
}

function buildLexicalRows(lexical) {
  if (!lexical) return '';
  const rows = [];
  const r = lexical.rates || {};
  if (r.hedging > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Hedging language:</span> ' + r.hedging + '% rate — e.g. "I think", "maybe", "probably"</div>');
  if (r.certainty > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Certainty markers:</span> ' + r.certainty + '% rate — e.g. "definitely", "always"</div>');
  if (r.filler > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Filler words:</span> ' + r.filler + '% rate — e.g. "um", "like", "you know"</div>');
  if (r.emotional > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Emotional language:</span> ' + r.emotional + '% rate</div>');
  if (r.exclusive > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Qualifying words:</span> ' + r.exclusive + '% rate — e.g. "but", "except"</div>');
  if (r.firstPersonSg > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">First-person singular:</span> ' + r.firstPersonSg + '% rate</div>');
  if (lexical.wordsPerSecond != null) {
    const rateDesc = lexical.wordsPerSecond > 3.5 ? 'fast' : lexical.wordsPerSecond < 2 ? 'slow' : 'moderate';
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Speech rate:</span> ' + lexical.wordsPerSecond + ' w/s (' + rateDesc + ')</div>');
  }
  return rows.join('');
}

function buildCard(result) {
  const color = colorForVerdict(result.verdict, result.confidence);
  const convictionColor = result.speaker_confidence === 'HIGH' ? 'green'
                        : result.speaker_confidence === 'LOW'  ? 'red'
                        : 'yellow';

  const card = document.createElement('div');
  card.className = 'rtfc-verdict rtfc-verdict--' + color + (result.pending ? ' rtfc-verdict--pending' : '');
  card.dataset.claim = result.claim.toLowerCase().slice(0, 40);
  if (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined) {
    card.dataset.speakerid = String(result.dominantSpeakerId);
  }
  card._resultData = result;

  const sourcesHTML = (result.sources ?? []).map((url, i) => {
    const isUrl = url.startsWith('http://') || url.startsWith('https://');
    return isUrl
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Source ' + (i + 1) + '</a>'
      : '<span class="rtfc-source-text">' + escapeHtml(url) + '</span>';
  }).join('');

  const lexicalRows = buildLexicalRows(result.lexical);

  // speaker tag — only show on grounded cards AND only when all speakers confirmed
  // this prevents wrong tags from appearing before diarization stabilizes
  let speakerTag = '';
  if (!result.pending && allSpeakersConfirmed()) {
    const confirmedName = (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined)
      ? confirmedSpeakerMap[result.dominantSpeakerId]
      : undefined;
    const rawSpeaker = (confirmedName !== undefined && confirmedName !== null)
      ? confirmedName
      : result.speaker || null;
    const normalizedName = rawSpeaker ? normalizeSpeakerName(rawSpeaker) : null;
    const speakerName  = (normalizedName && !normalizedName.match(/^Speaker\s*\d+$/i)) ? normalizedName : null;
    const speakerColor = speakerName ? getSpeakerColor(speakerName) : null;
    if (speakerColor) {
      speakerTag = '<div class="rtfc-speaker-tag" style="background:' + speakerColor + '">' + escapeHtml(speakerName) + '</div>';
    }
  }

  card.innerHTML = [
    speakerTag,
    '<div class="rtfc-verdict-header">',
      '<span class="rtfc-badge rtfc-badge--' + color + '">' + escapeHtml(result.verdict) + '</span>',
      result.pending ? '<span class="rtfc-verifying">⟳ verifying...</span>' : '',
      '<span class="rtfc-confidence-right">' + escapeHtml(result.confidence) + ' certainty</span>',
      '<span class="rtfc-timestamp">' + escapeHtml(result._timestamp || '') + '</span>',
    '</div>',
    '<p class="rtfc-claim">"' + escapeHtml(result.claim) + '"</p>',
    '<p class="rtfc-explanation">' + escapeHtml(result.explanation) + '</p>',
    '<div class="rtfc-speaker-confidence">',
      '<button class="rtfc-speaker-toggle">',
        '<span class="rtfc-speaker-dot rtfc-speaker-dot--' + convictionColor + '"></span>',
        'Speaker conviction: ' + escapeHtml(result.speaker_confidence || 'N/A'),
        '<span class="rtfc-speaker-arrow">▾</span>',
      '</button>',
      '<div class="rtfc-speaker-explanation" style="display:none">',
        lexicalRows,
      '</div>',
    '</div>',
    (sourcesHTML && sourcesHTML.trim()) ? '<div class="rtfc-sources">' + sourcesHTML + '</div>' : '',
  ].join('');

  const toggleBtn = card.querySelector('.rtfc-speaker-toggle');
  const reasons   = card.querySelector('.rtfc-speaker-explanation');
  const arrow     = card.querySelector('.rtfc-speaker-arrow');
  toggleBtn.addEventListener('click', () => {
    const open = reasons.style.display === 'none';
    reasons.style.display = open ? 'block' : 'none';
    arrow.textContent = open ? '▴' : '▾';
  });

  return card;
}

function findPendingCard(claim) {
  const key = claim.toLowerCase().slice(0, 40);
  if (pendingCards.has(key)) return pendingCards.get(key);

  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestCard = null, bestScore = 0;
  for (const [cardKey, card] of pendingCards) {
    const cardWords = cardKey.split(/\s+/).filter(w => w.length >= 4);
    const overlap = cardWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, cardWords.length);
    if (score > bestScore) { bestScore = score; bestCard = card; }
  }
  if (bestScore >= 0.4) return bestCard;
  return verdictListEl?.querySelector('.rtfc-verdict--pending');
}

function getVideoTimestamp() {
  const video = document.querySelector('video');
  if (!video) return '';
  const s = Math.floor(video.currentTime);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function getClaimTimestamp(claim) {
  if (!sentenceTimestamps.length) return lastTranscriptTimestamp || getClockTimecode();
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestMatch = null, bestScore = 0;
  for (const entry of sentenceTimestamps) {
    const sentWords = entry.text.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = sentWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, sentWords.length);
    if (score > bestScore) { bestScore = score; bestMatch = entry; }
  }
  return bestScore >= 0.3 ? bestMatch.timestamp : (lastTranscriptTimestamp || getClockTimecode());
}

function addVerdict(result) {
  if (!verdictListEl) return;
  verdictListEl.querySelector('.rtfc-empty')?.remove();
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  const card = buildCard(result);
  if (result.pending) {
    const key = result.claim.toLowerCase().slice(0, 40);
    pendingCards.set(key, card);
    pendingCardTimes.set(key, Date.now());
  } else {
    logVerdict(result);
  }
  verdictListEl.prepend(card);
}

function updateVerdict(result) {
  const existing = findPendingCard(result.claim);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  // inherit dominantSpeakerId from pending card if grounded result doesn't have one
  if (existing && existing.dataset.speakerid && !result.dominantSpeakerId) {
    result.dominantSpeakerId = existing.dataset.speakerid;
  }
  const newCard = buildCard(result);
  if (existing) {
    existing.replaceWith(newCard);
    for (const [k, v] of pendingCards) {
      if (v === existing) { pendingCards.delete(k); pendingCardTimes.delete(k); break; }
    }
  } else {
    verdictListEl?.querySelector('.rtfc-empty')?.remove();
    verdictListEl?.prepend(newCard);
  }
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  logVerdict(result);
}

// ── Key points (neutral) ──────────────────────────────────────────────────────

// Category/verdict/confidence labels live in lang.js (KP_CATEGORY_META,
// verdictLabel(), confLabel()) so the panel and the export share one bilingual copy.

let kpCounter = 0;
const kpCards = new Map(); // id → card element

// Custom categories the AI may invent get a neutral colour + a Title-cased label.
function prettyCategory(cat) {
  if (!cat) return 'Otro';
  return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

function buildKeyPointCard(kp) {
  const meta = KP_CATEGORY_META[kp.category] || { label: prettyCategory(kp.category), color: '#64748b' };
  const card = document.createElement('div');
  card.className = 'rtfc-keypoint';
  card._kpData = kp;
  card.dataset.kpid = String(kp._id);
  kpCards.set(kp._id, card);

  const rawSpeaker = (kp.speaker && !String(kp.speaker).match(/^Speaker\s*\d+$/i)) ? kp.speaker : null;
  const speakerName = rawSpeaker ? normalizeSpeakerName(rawSpeaker) : null;
  // The tag is always there, even with no speaker: people introduce themselves mid
  // conference, so there must be somewhere to click and put a name to a point.
  const speakerTag = speakerName
    ? '<div class="rtfc-speaker-tag" style="background:' + getSpeakerColor(speakerName) + '" title="' + escapeHtml(t('ov_kp_speaker_edit_title')) + '">' + escapeHtml(speakerName) + '</div>'
    : '<div class="rtfc-speaker-tag rtfc-speaker-tag--unset" title="' + escapeHtml(t('ov_kp_speaker_set_title')) + '">' + escapeHtml(t('ov_kp_speaker_unset')) + '</div>';

  const quoteHTML = kp.quote
    ? '<p class="rtfc-kp-quote">“' + escapeHtml(kp.quote) + '”</p>'
    : '';

  // The exact model is on hover: the card has no room, but it answers "which Mistral?".
  const modelTag = kp.model
    ? '<span class="rtfc-kp-model"' + (kp.modelId ? ' title="' + escapeHtml(kp.modelId) + '"' : '') + '>' +
      escapeHtml(t('ov_via') + ' ' + ((typeof providerLabel === 'function') ? providerLabel(kp.model) : kp.model)) + '</span>'
    : '';

  card.innerHTML = [
    speakerTag,
    '<div class="rtfc-kp-header">',
      '<span class="rtfc-kp-cat" style="background:' + meta.color + '">' + escapeHtml(meta.label) + '</span>',
      modelTag,
      '<span class="rtfc-timestamp">' + escapeHtml(kp._timestamp || '') + '</span>',
    '</div>',
    '<p class="rtfc-kp-point">' + escapeHtml(kp.point) + '</p>',
    quoteHTML,
    '<div class="rtfc-kp-actions">',
      // Verification needs live web search, which doesn't work on the Groq free tier
      // (returns 413). Disabled for now; re-enable when a search-capable provider is set.
      '<button class="rtfc-verify-btn" disabled title="' + escapeHtml(t('ov_verify_disabled_title')) + '">' + escapeHtml(t('ov_verify')) + '</button>',
      '<button class="rtfc-reinforce-btn" title="' + escapeHtml(t('ov_reinforce_title')) + '">👍</button>',
      '<button class="rtfc-edit-btn" title="' + escapeHtml(t('ov_edit_title')) + '">✏️</button>',
      '<button class="rtfc-discard-btn" title="' + escapeHtml(t('ov_discard_title')) + '">👎</button>',
    '</div>',
  ].join('');

  const speakerTagEl = card.querySelector('.rtfc-speaker-tag');
  if (speakerTagEl) speakerTagEl.addEventListener('click', () => editKeyPointSpeaker(card, kp));

  const btn = card.querySelector('.rtfc-verify-btn');
  if (btn && !btn.disabled) btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = t('ov_verifying');
    browser.runtime.sendMessage({
      type: 'VERIFY_KEYPOINT',
      id: kp._id,
      claim: kp.point,
      quote: kp.quote || '',
    });
  });

  const discardBtn = card.querySelector('.rtfc-discard-btn');
  if (discardBtn) discardBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'FEEDBACK_NEGATIVE', text: kp.point });
    kpCards.delete(kp._id);
    card.remove();
  });

  // 👍 Reinforce a good key point: learn to prioritise its like. Keeps the card.
  const reinforceBtn = card.querySelector('.rtfc-reinforce-btn');
  if (reinforceBtn) reinforceBtn.addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'FEEDBACK_POSITIVE', text: kp.point });
    reinforceBtn.disabled = true;
    reinforceBtn.classList.add('rtfc-reinforced');
    reinforceBtn.title = t('ov_reinforced_title');
  });

  // ✏️ Correct a mis-summarised point: edit its text inline; the correction updates the
  // card + the export, and is stored as a positive example so future points improve.
  const editBtn = card.querySelector('.rtfc-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    const pointEl = card.querySelector('.rtfc-kp-point');
    const actions = card.querySelector('.rtfc-kp-actions');
    if (!pointEl || card.querySelector('.rtfc-kp-edit')) return; // already editing
    const original = kp.point;
    const editor = document.createElement('div');
    editor.className = 'rtfc-kp-edit';
    const ta = document.createElement('textarea');
    ta.className = 'rtfc-kp-edit-area';
    ta.value = kp.point;
    const save = document.createElement('button');
    save.className = 'rtfc-kp-edit-save';
    save.textContent = t('ov_save');
    const cancel = document.createElement('button');
    cancel.className = 'rtfc-kp-edit-cancel';
    cancel.textContent = t('ov_cancel');
    editor.appendChild(ta);
    editor.appendChild(save);
    editor.appendChild(cancel);
    pointEl.style.display = 'none';
    if (actions) actions.style.display = 'none';
    pointEl.insertAdjacentElement('afterend', editor);
    keepKeysInPanel(ta);
    ta.focus();

    const close = () => {
      editor.remove();
      pointEl.style.display = '';
      if (actions) actions.style.display = '';
    };
    cancel.addEventListener('click', close);
    save.addEventListener('click', () => {
      const newText = ta.value.trim();
      if (newText && newText !== original) {
        kp.point = newText;
        pointEl.textContent = newText;
        if (typeof updateKeyPointText === 'function') updateKeyPointText(kp._id, newText);
        browser.runtime.sendMessage({ type: 'FEEDBACK_CORRECTION', original, corrected: newText });
      }
      close();
    });
  });

  return card;
}

// ── Naming a speaker from a key-point card ────────────────────────────────────
// Someone starts speaking before the user has added them as a participant, so the AI
// tags the point "Otro" or leaves it blank. Clicking the tag puts a name to it AND
// registers that name as a participant, so the REST of the session gets attributed
// properly (the background builds its speaker legend from the participant list).

// Labels the model uses when it can't attribute a point — both languages, since a
// session can carry points extracted before a language switch.
function isUnattributedSpeaker(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'otro' || n === 'other';
}

function editKeyPointSpeaker(card, kp) {
  if (!card || card.querySelector('.rtfc-kp-speaker-edit')) return; // already editing
  const tag = card.querySelector('.rtfc-speaker-tag');
  if (!tag) return;

  const editor = document.createElement('div');
  editor.className = 'rtfc-kp-speaker-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rtfc-kp-speaker-input';
  input.placeholder = t('ov_kp_speaker_ph');
  input.value = isUnattributedSpeaker(kp.speaker) ? '' : kp.speaker;
  const save = document.createElement('button');
  save.className = 'rtfc-kp-edit-save';
  save.textContent = t('ov_save');
  const cancel = document.createElement('button');
  cancel.className = 'rtfc-kp-edit-cancel';
  cancel.textContent = t('ov_cancel');
  editor.appendChild(input);
  editor.appendChild(save);
  editor.appendChild(cancel);

  tag.style.display = 'none';
  tag.insertAdjacentElement('afterend', editor);
  keepKeysInPanel(input);
  input.focus();
  input.select();

  const close = () => { editor.remove(); tag.style.display = ''; };
  const commit = () => {
    const name = input.value.trim();
    if (name) applyKeyPointSpeaker(card, kp, name);
    close();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  save.addEventListener('click', commit);
  cancel.addEventListener('click', close);
}

function applyKeyPointSpeaker(card, kp, name) {
  kp.speaker = name;
  const tag = card.querySelector('.rtfc-speaker-tag');
  if (tag) {
    tag.textContent = name;
    tag.classList.remove('rtfc-speaker-tag--unset');
    tag.style.background = getSpeakerColor(name);
    tag.title = t('ov_kp_speaker_edit_title');
  }
  if (typeof updateKeyPointSpeaker === 'function') updateKeyPointSpeaker(kp._id, name);
  // Only THIS card: two points tagged "Otro" may well be two different people.
  if (!participantNames.includes(name)) {
    participantNames.push(name);
    browser.runtime.sendMessage({ type: 'ADD_PARTICIPANT', name });
    renderParticipantsBar();
  }
}

function addKeyPoint(kp) {
  if (!verdictListEl) return;
  verdictListEl.querySelector('.rtfc-empty')?.remove();
  // Prefer the timecode resolved at extraction time (background matched the quote to
  // its transcript sentence); the word-overlap reverse guess is only a fallback now.
  if (!kp._timestamp) kp._timestamp = kp.timecode || getClaimTimestamp(kp.quote || kp.point);
  kp._id = ++kpCounter;
  const card = buildKeyPointCard(kp);
  verdictListEl.prepend(card);
  if (typeof logKeyPoint === 'function') logKeyPoint(kp);
}

// Re-paint a session recovered after a page reload (see restoreSession in
// session-export.js): transcript lines and model markers in their original order,
// then the key-point cards oldest-first (buildKeyPointCard is prepended, like
// addKeyPoint does), then the summary. NOTHING here logs anything — the restored log
// IS the source, and re-logging would duplicate the whole session in the export.
function renderRestoredSession(data) {
  lastTranscriptSpeaker = null;

  (data.transcript || []).forEach(entry => {
    if (entry.modelChange) { addModelMarker(entry.modelChange); return; }
    addTranscriptLine(entry.timecode, entry.text, entry.translation, entry.speaker, entry.lineId, entry.translationSource);
    if (entry.timecode) lastTranscriptTimestamp = entry.timecode;
    sentenceTimestamps.push({ text: entry.text, timestamp: entry.timecode || '' });
  });
  // Keep only the newest lines, same cap the live path applies.
  while (sentenceTimestamps.length > MAX_TIMESTAMP_BUFFER) sentenceTimestamps.shift();
  if (transcriptFeedEl) transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;

  (data.keyPoints || []).forEach(entry => {
    // Reuse the stored id so later edits/verdicts still match the export entry.
    if (typeof entry.id === 'number' && entry.id > kpCounter) kpCounter = entry.id;
    const kp = {
      _id: entry.id,
      _timestamp: entry.timecode || '',
      category: entry.category,
      point: entry.point,
      quote: entry.quote || '',
      speaker: entry.speaker || null,
      model: entry.model || '',
    };
    verdictListEl?.querySelector('.rtfc-empty')?.remove();
    verdictListEl?.prepend(buildKeyPointCard(kp));
    if (entry.verdict) {
      applyKeyPointVerdict(entry.id, {
        verdict: entry.verdict,
        confidence: entry.confidence || '',
        explanation: entry.verdictExplanation || '',
        sources: entry.sources || [],
      });
    }
  });

  if (data.summary) renderSummary(data.summary, '', '');
}

function applyKeyPointVerdict(id, result) {
  const card = kpCards.get(id);
  if (!card) return;
  const actions = card.querySelector('.rtfc-kp-actions');

  if (!result || !result.verdict) {
    // Re-enable the button so the user can retry, and show the reason beside it
    // (don't destroy the actions, or there'd be nothing left to click).
    const btn = card.querySelector('.rtfc-verify-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('ov_verify'); }
    let note = card.querySelector('.rtfc-kp-noverdict');
    if (!note) {
      note = document.createElement('span');
      note.className = 'rtfc-kp-noverdict';
      if (actions) actions.insertAdjacentElement('afterend', note); else card.appendChild(note);
    }
    note.textContent = t('ov_no_verdict');
    return;
  }

  const color = colorForVerdict(result.verdict, result.confidence);
  const label = verdictLabel(result.verdict);
  const conf = result.confidence ? confLabel(result.confidence) : '';
  const sourcesHTML = (result.sources ?? []).map((url, i) =>
    (url.startsWith('http://') || url.startsWith('https://'))
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(t('ov_source')) + ' ' + (i + 1) + '</a>'
      : ''
  ).join('');

  const v = document.createElement('div');
  v.className = 'rtfc-kp-verdict rtfc-verdict--' + color;
  v.innerHTML = [
    '<div class="rtfc-kp-verdict-head">',
      '<span class="rtfc-badge rtfc-badge--' + color + '">' + escapeHtml(label) + '</span>',
      conf ? '<span class="rtfc-confidence-right">' + escapeHtml(conf) + ' ' + escapeHtml(t('ov_confidence')) + '</span>' : '',
    '</div>',
    '<p class="rtfc-explanation">' + escapeHtml(result.explanation || '') + '</p>',
    (sourcesHTML.trim() ? '<div class="rtfc-sources">' + sourcesHTML + '</div>' : ''),
  ].join('');

  if (actions) actions.replaceWith(v); else card.appendChild(v);
  if (typeof updateKeyPointVerdict === 'function') updateKeyPointVerdict(id, result);
}

// ── Final summary ──────────────────────────────────────────────────────────────

function generateSummary() {
  if (typeof buildSummaryInput !== 'function') return;
  const input = buildSummaryInput();
  if (!input || !input.trim()) { showError(t('ov_nothing_to_summarize')); return; }
  if (summaryEl) {
    summaryEl.style.display = '';
    summaryEl.innerHTML =
      '<div class="rtfc-summary-title">' + escapeHtml(t('ov_summary_title')) + '</div>' +
      '<div class="rtfc-summary-body rtfc-summary-loading">' + escapeHtml(t('ov_summary_loading')) + '</div>';
  }
  browser.runtime.sendMessage({ type: 'SUMMARIZE', input });
}

function renderSummary(text, provider, modelId) {
  if (!summaryEl) return;
  summaryEl.style.display = '';
  const title = '<div class="rtfc-summary-title">' + escapeHtml(t('ov_summary_title')) + '</div>';
  if (!text || !text.trim()) {
    summaryEl.innerHTML = title + '<div class="rtfc-summary-body">' + escapeHtml(t('ov_summary_failed')) + '</div>';
    return;
  }
  summaryEl.innerHTML = title;
  const body = document.createElement('div');
  body.className = 'rtfc-summary-body';
  body.textContent = text;
  summaryEl.appendChild(body);
  if (typeof setSummary === 'function') setSummary(text, provider, modelId);
}

// Participants bar: shows current participants and lets the user add more live
// (e.g. journalists who introduce themselves as they speak).
function renderParticipantsBar() {
  const el = panel && panel.querySelector('#rtfc-participants');
  if (!el) return;
  const chips = participantNames.map((n, i) =>
    '<span class="rtfc-part-chip">' +
      '<span class="rtfc-part-name" data-i="' + i + '" title="' + escapeHtml(t('ov_part_edit_title')) + '">' + escapeHtml(n) + '</span>' +
      '<button class="rtfc-part-del" data-i="' + i + '" title="' + escapeHtml(t('ov_part_del_title')) + '">✕</button>' +
    '</span>'
  ).join('');
  el.innerHTML =
    '<span class="rtfc-part-label">' + escapeHtml(t('ov_participants')) + '</span>' +
    chips +
    '<input class="rtfc-part-input" placeholder="' + escapeHtml(t('ov_part_ph')) + '" />';

  el.querySelectorAll('.rtfc-part-name').forEach(span => {
    span.addEventListener('click', () => editParticipant(parseInt(span.dataset.i)));
  });

  const input = el.querySelector('.rtfc-part-input');
  keepKeysInPanel(input);
  // Saved on Enter AND on leaving the field: pressing Enter over a video pauses it, so
  // clicking away has to be enough. Re-rendering the bar replaces this input, hence the
  // guard — the blur that the re-render itself causes must not run the commit twice.
  let committed = false;
  const commitNames = () => {
    if (committed) return;
    const names = input.value.split(',').map(s => s.trim()).filter(Boolean);
    input.value = '';
    let added = false;
    for (const name of names) {
      if (!participantNames.includes(name)) {
        participantNames.push(name);
        browser.runtime.sendMessage({ type: 'ADD_PARTICIPANT', name });
        added = true;
      }
    }
    if (added) { committed = true; renderParticipantsBar(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitNames();
  });
  input.addEventListener('blur', commitNames);

  el.querySelectorAll('.rtfc-part-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.i);
      const name = participantNames[i];
      if (name == null) return;
      participantNames.splice(i, 1);
      browser.runtime.sendMessage({ type: 'REMOVE_PARTICIPANT', name });
      renderParticipantsBar();
    });
  });
}

// Edit a participant's name in place (fix typos) and update everything already tagged.
function editParticipant(i) {
  const oldName = participantNames[i];
  if (oldName == null) return;
  const newName = (window.prompt(t('ov_part_edit_prompt'), oldName) || '').trim();
  if (!newName || newName === oldName) return;
  participantNames[i] = newName;
  browser.runtime.sendMessage({ type: 'RENAME_PARTICIPANT', oldName, newName });
  renameSpeakerInCards(oldName, newName);
  if (typeof updateSpeakerName === 'function') updateSpeakerName(oldName, newName);
  renderParticipantsBar();
}

// Update the speaker shown on key-point cards already on screen after a rename.
function renameSpeakerInCards(oldName, newName) {
  kpCards.forEach(card => {
    if (card._kpData && card._kpData.speaker === oldName) {
      card._kpData.speaker = newName;
      const tag = card.querySelector('.rtfc-speaker-tag');
      if (tag) tag.textContent = newName;
    }
  });
}

// ⭐ "Interesante": select text in the transcript → add it as a key point + learn.

// The raw selection carries transcript furniture — "[23:48:39]" timecodes, "↳ "
// translation markers, line breaks — which made the model summarize only part of a
// multi-line selection. Strip it all down to plain running text.
function cleanTranscriptSelection(text) {
  return text
    // Drop "↳ translation" lines whole, not just their marker. The fragment becomes a
    // key point's verbatim QUOTE, and a translation is derived text — often an AI's: a ⭐
    // over a French passage once quoted the AI's Spanish between the real sentences.
    .replace(/(^|\n)[ \t]*↳[^\n]*/g, '$1')
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve who said the selected fragment: from the selection's START (document
// order), climb to its transcript line and walk backwards to the nearest speaker
// header shown in the feed.
function findSelectionSpeaker(sel) {
  try {
    if (!sel || !sel.rangeCount || !transcriptFeedEl) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const line = node && node.closest ? node.closest('.rtfc-transcript-line, .rtfc-tr-speaker') : null;
    let el = line || null;
    while (el) {
      if (el.classList && el.classList.contains('rtfc-tr-speaker')) return el.textContent.trim() || null;
      el = el.previousElementSibling;
    }
  } catch { /* selection APIs can be finicky — a missing speaker is fine */ }
  return null;
}

// The spoken text of a transcript line only: the direct text node, dropping the
// [timecode] chip (a <span>) and the "↳ translation" sub-line (a <div>), which are
// child elements — so context lines don't carry furniture or the translated copy.
function transcriptLineText(line) {
  let s = '';
  line.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) s += n.textContent; });
  return s.trim();
}

// The timecode of the transcript line where the selection STARTS — that is when the
// selected statement was said (the ⭐ click can happen much later).
function findSelectionTimecode(sel) {
  try {
    if (!sel || !sel.rangeCount || !transcriptFeedEl) return '';
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const line = node && node.closest ? node.closest('.rtfc-transcript-line') : null;
    const tc = line ? line.querySelector('.rtfc-tc') : null;
    return tc ? tc.textContent.replace(/[\[\]]/g, '').trim() : '';
  } catch { return ''; }
}

// Gather a few transcript lines BEFORE the selection as context. Gladia gives us no
// speaker labels, so these preceding lines are the model's main signal for who is
// speaking and what a manually-marked fragment refers to.
function collectPrecedingContext(sel, maxLines = 6) {
  try {
    if (!sel || !sel.rangeCount || !transcriptFeedEl) return '';
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const line = node && node.closest ? node.closest('.rtfc-transcript-line') : null;
    if (!line) return '';
    const before = [];
    let el = line.previousElementSibling;
    while (el && before.length < maxLines) {
      if (el.classList && el.classList.contains('rtfc-transcript-line')) {
        const txt = transcriptLineText(el);
        if (txt) before.unshift(txt);
      }
      el = el.previousElementSibling;
    }
    return before.join(' ');
  } catch { return ''; }
}

function setupInterestingButton() {
  if (interestingBtn) return;
  interestingBtn = document.createElement('button');
  interestingBtn.id = 'rtfc-interesting';
  interestingBtn.textContent = t('ov_interesting');
  interestingBtn.style.display = 'none';
  document.body.appendChild(interestingBtn);

  interestingBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  interestingBtn.addEventListener('click', () => {
    const sel = window.getSelection();
    const text = sel ? cleanTranscriptSelection(sel.toString()) : '';
    const speaker = sel ? findSelectionSpeaker(sel) : null;
    const context = sel ? collectPrecedingContext(sel) : '';
    const timecode = sel ? findSelectionTimecode(sel) : '';
    if (text) browser.runtime.sendMessage({ type: 'ADD_MANUAL_KEYPOINT', text, speaker, context, timecode });
    if (sel) sel.removeAllRanges();
    hideInterestingBtn();
  });

  if (!transcriptFeedEl) return;
  transcriptFeedEl.addEventListener('mouseup', (e) => {
    // Show the button right where the mouse released the selection (clamped to the
    // viewport), not above the selection where it overlapped the panel header.
    const x = e.clientX, y = e.clientY;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text && sel.rangeCount && transcriptFeedEl.contains(sel.anchorNode)) {
        interestingBtn.style.display = 'block';
        const bw = interestingBtn.offsetWidth || 110;
        const bh = interestingBtn.offsetHeight || 26;
        interestingBtn.style.left = Math.max(4, Math.min(x + 10, window.innerWidth - bw - 6)) + 'px';
        interestingBtn.style.top  = Math.max(4, Math.min(y + 12, window.innerHeight - bh - 6)) + 'px';
      } else {
        hideInterestingBtn();
      }
    }, 0);
  });
}

function hideInterestingBtn() {
  if (interestingBtn) interestingBtn.style.display = 'none';
}

function makeDraggable(panel) {
  const header = panel.querySelector('#rtfc-header');
  let isDragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'rtfc-close' || e.target.id === 'rtfc-export') return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.right = 'unset';
    panel.style.left  = Math.max(0, startLeft + e.clientX - startX) + 'px';
    panel.style.top   = Math.max(0, startTop  + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'grab'; });
}

// Drag the bottom-LEFT corner to resize: the panel is pinned by its RIGHT edge
// (it lives at the right side of the screen) and grows leftwards/downwards.
function makeResizable(panel) {
  const handle = document.createElement('div');
  handle.id = 'rtfc-resize';
  handle.title = t('ov_resize_title');
  panel.appendChild(handle);

  let isResizing = false, startX, startY, startW, startH;
  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startW = rect.width; startH = rect.height;
    // Pin the panel by its top-right and lift the height cap so it can grow freely.
    panel.style.left = 'unset';
    panel.style.right = (window.innerWidth - rect.right) + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.maxHeight = 'none';
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    // Dragging left makes it wider (the right edge stays put).
    const w = Math.max(260, Math.min(startW - (e.clientX - startX), window.innerWidth - 20));
    const h = Math.max(220, Math.min(startH + e.clientY - startY, window.innerHeight - 20));
    panel.style.width  = w + 'px';
    panel.style.height = h + 'px';
  });
  document.addEventListener('mouseup', () => { isResizing = false; });
}

// ── Messages ──────────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg) => {
  // Child frames (all_frames) never build UI — they only start/stop audio capture,
  // so a player inside a cross-origin iframe (e.g. Vimeo embed) can be captured.
  // IS_TOP_FRAME is defined in audio-capture.js (loaded before this script).
  if (typeof IS_TOP_FRAME !== 'undefined' && !IS_TOP_FRAME) {
    if (msg.type === 'START_FACTCHECK' && typeof startAudioCapture === 'function') {
      startAudioCapture({ resume: !!msg.resume, captureMode: msg.captureMode, gladiaSessionUrl: msg.gladiaSessionUrl });
    }
    else if (msg.type === 'STOP_FACTCHECK' && typeof stopAudioCapture === 'function') stopAudioCapture();
    return;
  }
  console.log('[overlay] message received:', msg.type);
  switch (msg.type) {

    case 'START_FACTCHECK': {
      // msg.resume = the page was reloaded and the background is restarting the SAME
      // session. If the panel is still alive nothing was destroyed (e.g. an in-page
      // navigation), so there is nothing to rebuild — leaving it alone also avoids
      // starting a second audio capture on top of the running one.
      const isResume = !!msg.resume;
      if (isResume && panel) break;
      // Resolve the UI language BEFORE building the panel so every string is right.
      browser.storage.local.get(['participants', 'uiLanguage']).then(async d => {
        setUiLang(d.uiLanguage || defaultUiLanguage());
        createPanel();
        setDotState('connecting');
        participantNames = (d.participants || '').split(',').map(s => s.trim()).filter(Boolean);
        renderParticipantsBar();
        const restored = (isResume && typeof restoreSession === 'function')
          ? await restoreSession(msg.sessionId)
          : null;
        if (restored) {
          renderRestoredSession(restored);
          showError(t('ov_session_resumed'), 'info');
        } else {
          startSession(msg.sessionId);
        }
        speakers = parseSpeakersFromTitle(document.title || '');
        speakerColorMap.clear();
        browser.runtime.sendMessage({
          type:  'PAGE_TITLE',
          title: document.title || '',
          date:  (() => {
            const el = document.querySelector('meta[itemprop="uploadDate"]') ||
                       document.querySelector('meta[property="og:updated_time"]');
            return el ? new Date(el.content).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
          })(),
        });
        renderSpeakerEditor();
        if (typeof startAudioCapture === 'function') {
          startAudioCapture({ resume: isResume, captureMode: msg.captureMode, gladiaSessionUrl: msg.gladiaSessionUrl });
        }
      });
      break;
    }

    case 'STOP_FACTCHECK':
      stopSession();
      if (typeof stopAudioCapture === 'function') stopAudioCapture();
      removePanel();
      break;

    case 'TRANSCRIPT_RESULT':
      if (msg.isFinal || (msg.text && msg.text.trim() && msg.text.trim() !== '...')) setDotState('live');
      if (msg.interim) {
        updateInterim(msg.text);
      } else if (msg.isFinal) {
        const ts = msg.timecode || getClockTimecode();
        lastTranscriptTimestamp = ts;
        sentenceTimestamps.push({ text: msg.text, timestamp: ts });
        if (sentenceTimestamps.length > MAX_TIMESTAMP_BUFFER) sentenceTimestamps.shift();
        clearInterim();
        // strip [Speaker N] prefix before displaying
        const displayText = msg.text.replace(/^\[.*?\]\s*/, '');
        const translation = msg.translation || '';
        addTranscriptLine(ts, displayText, translation, msg.speaker || null, msg.lineId || null);
        if (typeof logTranscript === 'function') logTranscript(ts, displayText, translation, msg.speaker || null, msg.lineId || null);
        // track which speaker is active from label
        const labelMatch = msg.text.match(/^\[(.+?)\]/);
        if (labelMatch && speakers.includes(labelMatch[1])) {
          lastActiveSpeaker = labelMatch[1];
        }
      }
      break;

    case 'TRANSCRIPT_TRANSLATION':
      applyLateTranslation(msg.lineId, msg.translation || '', msg.source || 'google');
      if (typeof updateTranscriptTranslation === 'function') {
        updateTranscriptTranslation(msg.lineId, msg.translation || '', msg.source || 'google');
      }
      break;

    case 'NEW_SPEAKER':
      if (panel) showSpeakerBanner(msg.speakerId, msg.sample || '');
      break;

    case 'PIPELINE_ERROR':
      showError(msg.message || t('ov_pipeline_error'));
      setDotState('error');
      break;

    case 'PIPELINE_INFO':
      showError(msg.message || '', 'info');
      break;

    case 'MODEL_CHANGED': {
      // A fallback flipped the active model. Tell the user (toast), drop a marker in the
      // live transcript, and log it so the export shows when/where the model changed.
      const name = (typeof providerLabel === 'function') ? providerLabel(msg.provider) : msg.provider;
      const label = t('ov_model_changed') + ' ' + name;
      showError(label, 'info');
      const ts = lastTranscriptTimestamp || getClockTimecode();
      addModelMarker(label);
      if (typeof logModelChange === 'function') logModelChange(ts, label);
      break;
    }

    case 'CAPTURE_SILENT': {
      // Connected, but no sound reaches the extension. Red toast + dot, and a marker in the
      // feed/export; the AudioContext state is kept when abnormal, as evidence of which
      // fault it was (never started vs a blocked stream that runs silent).
      showError(msg.message || t('ov_no_sound_marker'));
      setDotState('error');
      const state = msg.contextState && msg.contextState !== 'running' ? ' [' + msg.contextState + ']' : '';
      const marker = t('ov_no_sound_marker') + state;
      addModelMarker(marker);
      if (typeof logModelChange === 'function') logModelChange(lastTranscriptTimestamp || getClockTimecode(), marker);
      break;
    }

    case 'TRANSLATOR_STATUS': {
      // Google Translate stopped (with the reason) or came back. Same treatment as a model
      // change: a toast now, a marker in the feed, and a timed line in the export — so a
      // failure is evidence on record, not something guessed at afterwards.
      const label = msg.label || '';
      if (!label) break;
      showError(label, 'info');
      addModelMarker(label);
      if (typeof logModelChange === 'function') logModelChange(lastTranscriptTimestamp || getClockTimecode(), label);
      break;
    }

    // The same statement came back with more context (often completing a ⭐ fragment).
    // One card: its text is replaced, and the ✏️ is there if it went too far.
    case 'EXPAND_KEYPOINT': {
      for (const card of kpCards.values()) {
        if (!card._kpData || card._kpData.point !== msg.previous) continue;
        const pointEl = card.querySelector('.rtfc-kp-point');
        if (!pointEl || card.querySelector('.rtfc-kp-edit')) break; // he is editing it right now
        card._kpData.point = msg.point;
        pointEl.textContent = msg.point;
        pointEl.title = t('ov_kp_expanded_title');
        if (typeof updateKeyPointText === 'function') updateKeyPointText(card._kpData._id, msg.point);
        break;
      }
      break;
    }

    case 'NEW_KEYPOINTS':
      if (msg.results) {
        for (const kp of msg.results) addKeyPoint(kp);
      }
      break;

    case 'CAPTURE_READY':
      setDotState('ready');
      break;

    case 'KEYPOINT_VERDICT':
      applyKeyPointVerdict(msg.id, msg.result);
      break;

    case 'SUMMARY_RESULT':
      renderSummary(msg.text || '', msg.provider || '', msg.modelId || '');
      // The user asked to close WITH a summary: it's in the log now, so export and go.
      if (closeAfterSummary) finishCloseWithSummary();
      break;

    case 'NEW_VERDICT':
      if (msg.results) {
        for (const result of msg.results) {
          addClaimBullet(result.claim);
          addVerdict(result);
        }
      }
      break;

    case 'UPDATE_VERDICTS':
      if (msg.results) {
        for (const result of msg.results) {
          updateVerdict(result);
        }
      }
      break;
  }
});