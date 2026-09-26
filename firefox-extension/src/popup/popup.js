// popup.js — the browser-action panel: only what you touch to start a session
// (press-conference language, participants, Start). Everything you configure once
// lives in the settings view (settings.js), shown in place of this one from the ⚙.

const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const sourceLanguageEl = document.getElementById('sourceLanguage');
const sourceSearchEl = document.getElementById('sourceLanguageSearch');
const participantsEl = document.getElementById('participants');
const keyHint = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');
const settingsBtn = document.getElementById('settingsBtn');
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');

let isActive = false;
// Credentials are owned by the settings view; the popup only reads them to know whether
// a session can start at all, and which engine will be used.
let mode = 'apikey';
let hasAnthropicKey = false;
let hasProxyUrl = false;
let hasGladiaKey = false;
// Kept up to date by the background (browser start, URL change, popup open), so a dead
// proxy blocks Start before anyone clicks it.
let proxyStatus = { state: 'off' };

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  setActive(isActive); // refresh status + toggle-button texts
}

// ── Source-language picker ────────────────────────────────────────────────────
// Gladia transcribes 99 languages, which is far too many for a plain dropdown, so the
// list is filtered by a search box: type a name (in either language, accents optional)
// or the code. Only matches are listed, and the first one is selected as you type, so
// the setting can never end up empty.

// 'auto' always leads; the rest are sorted by their name in the current UI language.
function sourceLanguageCodes(query) {
  const q = normalizeSearch(query);
  const codes = GLADIA_LANGUAGES
    .filter(c => languageMatches(c, q))
    .sort((a, b) => languageDisplayName(a).localeCompare(languageDisplayName(b), getUiLang()));
  const autoMatches = !q || normalizeSearch(t('p_opt_auto')).includes(q) || 'auto'.includes(q);
  return autoMatches ? ['auto', ...codes] : codes;
}

function renderSourceLanguageOptions(codes, selected) {
  sourceLanguageEl.innerHTML = '';
  for (const code of codes) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = code === 'auto' ? t('p_opt_auto') : languageOptionLabel(code);
    sourceLanguageEl.appendChild(o);
  }
  sourceLanguageEl.value = selected;
  // Nothing matched the stored code (it was filtered out): fall back to the first result.
  if (!sourceLanguageEl.value && codes.length) sourceLanguageEl.value = codes[0];
}

sourceSearchEl.addEventListener('input', () => {
  const query = sourceSearchEl.value.trim();
  const codes = sourceLanguageCodes(query);
  // No matches: leave the current choice alone rather than wiping it.
  sourceSearchEl.classList.toggle('no-match', !!query && !codes.length);
  if (!codes.length) return;
  const keep = codes.includes(sourceLanguageEl.value) ? sourceLanguageEl.value : codes[0];
  renderSourceLanguageOptions(codes, keep);
  // Show the results as a list while searching; back to a dropdown when cleared.
  sourceLanguageEl.size = query ? Math.min(6, Math.max(2, codes.length)) : 1;
  browser.storage.local.set({ sourceLanguage: sourceLanguageEl.value });
});

sourceLanguageEl.addEventListener('change', () => {
  browser.storage.local.set({ sourceLanguage: sourceLanguageEl.value });
  // Picking from the results closes the search: back to the full dropdown.
  if (sourceSearchEl.value) {
    sourceSearchEl.value = '';
    sourceSearchEl.classList.remove('no-match');
    renderSourceLanguageOptions(sourceLanguageCodes(''), sourceLanguageEl.value);
    sourceLanguageEl.size = 1;
  }
});

participantsEl.addEventListener('change', () => {
  browser.storage.local.set({ participants: participantsEl.value.trim() });
});

// ── Settings ──────────────────────────────────────────────────────────────────

// Both views live in this one panel; the ⚙ and the ← just swap which one is shown.
function showSettings(show) {
  mainView.hidden = show;
  settingsView.hidden = !show;
  window.scrollTo(0, 0);
}

settingsBtn.addEventListener('click', () => showSettings(true));
document.getElementById('backBtn').addEventListener('click', () => showSettings(false));

// Show the installed version in the header (from the manifest, so it updates itself),
// with a β while the add-on is running unsigned from disk.
const popupVersionEl = document.getElementById('popupVersion');
if (popupVersionEl) versionLabel().then(label => { popupVersionEl.textContent = label; });

// ── Load saved config ─────────────────────────────────────────────────────────

function readCredentials(data) {
  mode = data.connectionMode === 'proxy' ? 'proxy' : 'apikey';
  hasAnthropicKey = !!(data.anthropicKey || '').trim();
  hasProxyUrl = !!(data.proxyUrl || '').trim();
  hasGladiaKey = !!(data.gladiaKey || '').trim();
}

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'gladiaKey', 'sourceLanguage', 'participants', 'connectionMode', 'uiLanguage', 'proxyStatus']).then(data => {
  setUiLang(data.uiLanguage || defaultUiLanguage());
  readCredentials(data);
  if (data.proxyStatus) proxyStatus = data.proxyStatus;

  renderSourceLanguageOptions(sourceLanguageCodes(''), data.sourceLanguage || 'auto');
  if (data.participants) participantsEl.value = data.participants;

  applyI18n();
  updateHint();
});

// The settings view saves straight to storage; follow it so the main view is already
// right when you come back with ←.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['anthropicKey', 'proxyUrl', 'gladiaKey', 'connectionMode'].some(k => k in changes)) {
    browser.storage.local.get(['anthropicKey', 'proxyUrl', 'gladiaKey', 'connectionMode']).then(data => {
      readCredentials(data);
      if (!isActive) updateHint();
    });
  }
  if (changes.proxyStatus) {
    proxyStatus = changes.proxyStatus.newValue || { state: 'off' };
    if (!isActive) updateHint();
  }
  if (changes.uiLanguage) {
    renderSourceLanguageOptions(sourceLanguageCodes(sourceSearchEl.value.trim()), sourceLanguageEl.value);
    applyI18n();
  }
});

// Tells the user whether a session can start, and with which transcription engine.
// The fix for anything missing is in the settings view, so say so.
function updateHint() {
  const configured = mode === 'proxy' ? hasProxyUrl : hasAnthropicKey;

  if (!configured) {
    keyHint.textContent = (mode === 'proxy' ? t('p_hint_enter_proxy') : t('p_hint_enter_key')) + ' ' + t('p_hint_in_settings');
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
    return;
  }

  if (mode === 'proxy' && proxyStatus.state === 'checking') {
    keyHint.textContent = t('p_checking_proxy');
    keyHint.className = 'key-hint';
    toggleBtn.disabled = !isActive;
    return;
  }
  if (mode === 'proxy' && proxyStatus.state === 'bad') {
    keyHint.textContent = proxyProblemText(proxyStatus);
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
    return;
  }

  keyHint.className = 'key-hint ok';
  toggleBtn.disabled = false;
  if (hasGladiaKey) keyHint.textContent = t('p_hint_ready_gladia_direct');
  else if (mode === 'proxy') keyHint.textContent = t('p_hint_ready_gladia_proxy');
  else keyHint.textContent = t('p_hint_ready_whisper');
}

// Opening the popup asks for a fresh check; the answer arrives through storage.onChanged.
browser.runtime.sendMessage({ type: 'CHECK_PROXY' }).catch(() => {});

// ── Status ────────────────────────────────────────────────────────────────────

browser.runtime.sendMessage({ type: 'GET_STATUS' }).then(res => {
  if (res?.isCapturing) setActive(true);
}).catch(() => {});

function setActive(active) {
  isActive = active;
  toggleBtn.textContent = active ? t('p_btn_stop') : t('p_btn_start');
  toggleBtn.className = 'toggle-btn' + (active ? ' active' : '');
  statusEl.textContent = active ? t('p_status_active') : t('p_status_inactive');
  statusEl.className = 'status' + (active ? ' active' : '');
  keysSection.style.display = active ? 'none' : 'flex';
  if (!active) updateHint();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', async () => {
  if (isActive) {
    browser.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    setActive(false);
    return;
  }

  if (mode === 'apikey' && !hasAnthropicKey) {
    keyHint.textContent = t('p_hint_enter_key') + ' ' + t('p_hint_in_settings');
    keyHint.className = 'key-hint error';
    return;
  }
  if (mode === 'proxy' && !hasProxyUrl) {
    keyHint.textContent = t('p_hint_enter_proxy') + ' ' + t('p_hint_in_settings');
    keyHint.className = 'key-hint error';
    return;
  }

  // These two are the popup's own fields; save them explicitly in case the click
  // beat the 'change' event.
  await browser.storage.local.set({
    sourceLanguage: sourceLanguageEl.value,
    participants: participantsEl.value.trim(),
  });

  // In proxy mode the background first checks the proxy answers, which can take a moment.
  if (mode === 'proxy') {
    keyHint.textContent = t('p_checking_proxy');
    keyHint.className = 'key-hint';
  }
  toggleBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({ type: 'START_FACTCHECK' });
    if (res?.ok) {
      setActive(true);
    } else {
      keyHint.textContent = t('p_start_failed') + (res?.error || 'unknown error');
      keyHint.className = 'key-hint error';
    }
  } catch (err) {
    keyHint.textContent = t('p_error') + err.message;
    keyHint.className = 'key-hint error';
  }
  toggleBtn.disabled = false;
});
