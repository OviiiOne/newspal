const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const anthropicEl = document.getElementById('anthropicKey');
const proxyUrlEl = document.getElementById('proxyUrl');
const proxyTokenEl = document.getElementById('proxyToken');
const gladiaEl = document.getElementById('gladiaKey');
const sourceLanguageEl = document.getElementById('sourceLanguage');
const understoodEl = document.getElementById('understoodLanguages');
const participantsEl = document.getElementById('participants');
const feedbackRulesEl = document.getElementById('feedbackRules');
const keyHint = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');
const modeApiKeyBtn = document.getElementById('modeApiKey');
const modeProxyBtn = document.getElementById('modeProxy');
const apiKeyFields = document.getElementById('apiKeyFields');
const proxyFields = document.getElementById('proxyFields');
const providerChainEl = document.getElementById('providerChain');
const testProvidersBtn = document.getElementById('testProvidersBtn');
const providerTestDetails = document.getElementById('providerTestDetails');
const uiLangEsBtn = document.getElementById('uiLangEs');
const uiLangEnBtn = document.getElementById('uiLangEn');

let isActive = false;
let mode = 'apikey';
let aiProvider = 'groq';
let understoodExplicit = false; // whether the user ever chose understood languages

// Provider fallback chain. All known providers; the enabled ones (in order) form the
// queue the background walks. Groq/Cerebras/Mistral are free; Gemini/Claude are paid.
const ALL_PROVIDERS = [
  { id: 'groq', name: 'Groq', free: true },
  { id: 'cerebras', name: 'Cerebras', free: true },
  { id: 'mistral', name: 'Mistral', free: true },
  // Gemini's AI Studio tier is free and needs no card, like the other three.
  { id: 'gemini', name: 'Gemini', free: true },
  { id: 'claude', name: 'Claude', free: false },
];
// Mistral leads by preference (European provider); the rest are the safety net.
// Keep in sync with DEFAULT_PROVIDER_CHAIN in background.js.
const DEFAULT_CHAIN = ['mistral', 'cerebras', 'groq'];
// Full display order with an enabled flag per provider (enabled ones lead, in chain order).
let providerOrder = [];
// Result of the last "test the models" run, per provider id:
// { state: 'testing' | 'ok' | 'fail', model?, err? }. Survives re-renders of the chain.
let providerStatus = {};

// ── UI language (bilingual edition) ──────────────────────────────────────────
// One setting drives the popup/overlay texts AND the language the AI writes in.

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  uiLangEsBtn.classList.toggle('active', getUiLang() === 'es');
  uiLangEnBtn.classList.toggle('active', getUiLang() === 'en');
  setActive(isActive); // refresh status + toggle-button texts
}

// ── Source-language picker ────────────────────────────────────────────────────
// Gladia transcribes 99 languages, which is far too many for a plain dropdown, so the
// list is filtered by a search box: type a name (in either language, accents optional)
// or the code. Only matches are listed, and the first one is selected as you type, so
// the setting can never end up empty.

const sourceSearchEl = document.getElementById('sourceLanguageSearch');

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

if (sourceSearchEl) {
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
}

// Rebuild both language selects with labels in the current UI language,
// preserving the current selections.
function buildLanguageSelects(selectedSource, selectedUnderstood) {
  const source = selectedSource !== undefined ? selectedSource : sourceLanguageEl.value || 'auto';
  const understood = selectedUnderstood !== undefined
    ? selectedUnderstood
    : [...understoodEl.selectedOptions].map(o => o.value);

  renderSourceLanguageOptions(sourceLanguageCodes(''), source);

  understoodEl.innerHTML = '';
  for (const l of EXT_LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l[getUiLang()] || l.en;
    o.selected = understood.includes(l.code);
    understoodEl.appendChild(o);
  }
}

function switchUiLang(lang) {
  setUiLang(lang);
  browser.storage.local.set({ uiLanguage: getUiLang() });
  // If the user never chose understood languages, follow the new language's default.
  buildLanguageSelects(undefined, understoodExplicit
    ? undefined
    : defaultUnderstoodLanguages(getUiLang()));
  applyI18n();
  updateHint();
}

uiLangEsBtn.addEventListener('click', () => switchUiLang('es'));
uiLangEnBtn.addEventListener('click', () => switchUiLang('en'));

// Show the installed version in the header (from the manifest, so it updates itself),
// with a β while the add-on is running unsigned from disk.
const popupVersionEl = document.getElementById('popupVersion');
if (popupVersionEl) versionLabel().then(label => { popupVersionEl.textContent = label; });

// ── Provider fallback chain (reorderable queue) ───────────────────────────────

// Build providerOrder from a saved chain: enabled providers first (in the saved order),
// then the remaining providers as disabled.
function initProviderOrder(savedChain) {
  const chain = (Array.isArray(savedChain) && savedChain.length) ? savedChain : DEFAULT_CHAIN;
  const enabled = chain.filter(id => ALL_PROVIDERS.some(p => p.id === id));
  const rest = ALL_PROVIDERS.map(p => p.id).filter(id => !enabled.includes(id));
  providerOrder = [
    ...enabled.map(id => ({ id, enabled: true })),
    ...rest.map(id => ({ id, enabled: false })),
  ];
}

function meta(id) { return ALL_PROVIDERS.find(p => p.id === id) || { id, name: id, free: false }; }

// The queue the background uses = enabled providers, in order.
function currentChain() {
  return providerOrder.filter(p => p.enabled).map(p => p.id);
}

function saveProviderChain() {
  const chain = currentChain();
  aiProvider = chain[0] || 'groq'; // keep the legacy single-provider setting in sync
  browser.storage.local.set({ aiProviderChain: chain, aiProvider });
  updateHint();
}

function moveProvider(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= providerOrder.length) return;
  const tmp = providerOrder[index];
  providerOrder[index] = providerOrder[j];
  providerOrder[j] = tmp;
  renderProviderChain();
  saveProviderChain();
}

function renderProviderChain() {
  providerChainEl.innerHTML = '';
  const enabledCount = providerOrder.filter(p => p.enabled).length;
  providerOrder.forEach((p, i) => {
    const m = meta(p.id);
    const row = document.createElement('div');
    row.className = 'provider-row' + (p.enabled ? ' enabled' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'provider-check';
    cb.checked = p.enabled;
    // Don't let the user disable the last enabled provider — the queue can't be empty.
    cb.disabled = p.enabled && enabledCount === 1;
    cb.addEventListener('change', () => {
      p.enabled = cb.checked;
      // Re-sort so enabled providers always lead, keeping relative order.
      const on = providerOrder.filter(x => x.enabled);
      const off = providerOrder.filter(x => !x.enabled);
      providerOrder = [...on, ...off];
      renderProviderChain();
      saveProviderChain();
    });

    const label = document.createElement('span');
    label.className = 'provider-name';
    label.textContent = m.name;
    if (m.free) {
      const tag = document.createElement('span');
      tag.className = 'free-tag';
      tag.textContent = 'free';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(tag);
    }

    const up = document.createElement('button');
    up.className = 'provider-move';
    up.textContent = '▲';
    up.disabled = i === 0;
    up.addEventListener('click', () => moveProvider(i, -1));

    const down = document.createElement('button');
    down.className = 'provider-move';
    down.textContent = '▼';
    down.disabled = i === providerOrder.length - 1;
    down.addEventListener('click', () => moveProvider(i, +1));

    const st = providerStatus[p.id];
    let badge = null;
    if (st) {
      badge = document.createElement('span');
      badge.className = 'provider-status ' + st.state;
      badge.textContent = st.state === 'ok' ? '✓' : st.state === 'fail' ? '✕' : '…';
      // The model that actually answered — that is what a retirement changes.
      badge.title = st.state === 'ok' ? (st.model || '') : (st.err || '');
    }

    row.appendChild(cb);
    row.appendChild(label);
    if (badge) row.appendChild(badge);
    row.appendChild(up);
    row.appendChild(down);
    providerChainEl.appendChild(row);
  });
}

// ── "Test the models" ─────────────────────────────────────────────────────────
// A hosted model can be retired without warning; the API then answers "the model …
// does not exist", which breaks EVERY provider in the queue at once and — because
// key-point extraction calls the chain silently — does it without a visible error.
// This asks each enabled provider for one word, so the queue can be checked before a
// press conference instead of during one. The proxy echoes the model it used.
async function testProvider(provider, proxyUrl, proxyToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (proxyToken) headers['x-proxy-token'] = proxyToken;
  try {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider,
        model: provider === 'gemini' ? 'gemini-2.0-flash'
             : provider === 'claude' ? 'claude-haiku-4-5-20251001' : undefined,
        // Not 16: a reasoning model spends the budget thinking and answers nothing,
        // which would report a healthy provider as broken.
        max_tokens: 1200,
        temperature: 0,
        system: 'Reply with the single word OK.',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { state: 'fail', err: data.error?.message || ('HTTP ' + res.status) };
    }
    if (!data?.content?.[0]?.text?.trim()) return { state: 'fail', err: t('p_test_empty') };
    return { state: 'ok', model: data.model || '' };
  } catch (err) {
    return { state: 'fail', err: err.message };
  }
}

function renderTestDetails() {
  providerTestDetails.innerHTML = '';
  for (const p of providerOrder) {
    const st = providerStatus[p.id];
    if (!st || st.state === 'testing') continue;
    const line = document.createElement('div');
    line.className = st.state;
    line.textContent = st.state === 'ok'
      ? fmt(t('p_test_ok'), { name: meta(p.id).name, model: st.model || '?' })
      : fmt(t('p_test_fail'), { name: meta(p.id).name, err: st.err || '' });
    providerTestDetails.appendChild(line);
  }
}

async function runProviderTest() {
  const chain = currentChain();
  providerStatus = {};
  renderTestDetails();

  // Direct-key mode has no queue: the single Anthropic key is tested by Start itself.
  if (mode !== 'proxy') {
    providerTestDetails.textContent = t('p_test_proxy_only');
    return;
  }
  const proxyUrl = proxyUrlEl.value.trim();
  if (!proxyUrl) {
    providerTestDetails.textContent = t('p_test_need_proxy');
    return;
  }
  const proxyToken = proxyTokenEl.value.trim();

  testProvidersBtn.disabled = true;
  testProvidersBtn.textContent = t('p_test_running');
  // Sequentially, not in parallel: a free tier that rate-limits on three simultaneous
  // calls would report a failure that the real chain (one call at a time) never sees.
  for (const id of chain) {
    providerStatus[id] = { state: 'testing' };
    renderProviderChain();
    providerStatus[id] = await testProvider(id, proxyUrl, proxyToken);
    renderProviderChain();
    renderTestDetails();
  }
  testProvidersBtn.disabled = false;
  testProvidersBtn.textContent = t('p_test_providers');
}

testProvidersBtn.addEventListener('click', runProviderTest);

// ── Load saved config ─────────────────────────────────────────────────────────

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'gladiaKey', 'sourceLanguage', 'participants', 'connectionMode', 'aiProvider', 'aiProviderChain', 'feedbackRules', 'uiLanguage', 'understoodLanguages']).then(data => {
  setUiLang(data.uiLanguage || defaultUiLanguage());
  understoodExplicit = Array.isArray(data.understoodLanguages) && data.understoodLanguages.length > 0;
  const understood = understoodExplicit ? data.understoodLanguages : defaultUnderstoodLanguages(getUiLang());
  buildLanguageSelects(data.sourceLanguage || 'auto', understood);

  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.proxyUrl) { proxyUrlEl.value = data.proxyUrl; proxyUrlEl.classList.add('saved'); }
  if (data.proxyToken) { proxyTokenEl.value = data.proxyToken; proxyTokenEl.classList.add('saved'); }
  if (data.gladiaKey) { gladiaEl.value = data.gladiaKey; gladiaEl.classList.add('saved'); }
  if (data.participants) participantsEl.value = data.participants;
  if (Array.isArray(data.feedbackRules)) feedbackRulesEl.value = data.feedbackRules.join('\n');
  if (data.connectionMode === 'proxy') switchMode('proxy');
  // Provider chain: prefer the saved ordered chain; fall back to the legacy single
  // provider; then to the default free chain.
  initProviderOrder(data.aiProviderChain || (data.aiProvider ? [data.aiProvider] : null));
  aiProvider = currentChain()[0] || 'groq';
  renderProviderChain();
  applyI18n();
  updateHint();
});

sourceLanguageEl.addEventListener('change', () => {
  browser.storage.local.set({ sourceLanguage: sourceLanguageEl.value });
  // Picking from the results closes the search: back to the full dropdown.
  if (sourceSearchEl && sourceSearchEl.value) {
    sourceSearchEl.value = '';
    sourceSearchEl.classList.remove('no-match');
    renderSourceLanguageOptions(sourceLanguageCodes(''), sourceLanguageEl.value);
    sourceLanguageEl.size = 1;
  }
});

understoodEl.addEventListener('change', () => {
  const langs = [...understoodEl.selectedOptions].map(o => o.value);
  understoodExplicit = langs.length > 0;
  browser.storage.local.set({ understoodLanguages: langs });
});

participantsEl.addEventListener('change', () => {
  browser.storage.local.set({ participants: participantsEl.value.trim() });
});

// Learned rules: one per line; the background picks up edits via storage.onChanged.
feedbackRulesEl.addEventListener('change', () => {
  const rules = feedbackRulesEl.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12);
  browser.storage.local.set({ feedbackRules: rules });
});

// ── Mode toggle ───────────────────────────────────────────────────────────────

function switchMode(newMode) {
  mode = newMode;
  if (mode === 'proxy') {
    modeProxyBtn.classList.add('active');
    modeApiKeyBtn.classList.remove('active');
    apiKeyFields.style.display = 'none';
    proxyFields.style.display = 'block';
  } else {
    modeApiKeyBtn.classList.add('active');
    modeProxyBtn.classList.remove('active');
    apiKeyFields.style.display = 'block';
    proxyFields.style.display = 'none';
  }
  browser.storage.local.set({ connectionMode: mode });
  updateHint();
}

modeApiKeyBtn.addEventListener('click', () => switchMode('apikey'));
modeProxyBtn.addEventListener('click', () => switchMode('proxy'));

// ── Save keys on change ───────────────────────────────────────────────────────

[anthropicEl, proxyUrlEl, proxyTokenEl, gladiaEl].forEach(el => {
  el.addEventListener('input', () => { el.classList.remove('saved'); updateHint(); });
  el.addEventListener('change', () => {
    const key = el.id;
    browser.storage.local.set({ [key]: el.value.trim() });
    el.classList.add('saved');
    updateHint();
  });
});

function updateHint() {
  const hasClaude = mode === 'proxy' ? proxyUrlEl.value.trim() : anthropicEl.value.trim();
  const hasGladia = gladiaEl.value.trim();

  if (!hasClaude) {
    keyHint.textContent = mode === 'proxy' ? t('p_hint_enter_proxy') : t('p_hint_enter_key');
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
  } else if (hasGladia) {
    keyHint.textContent = t('p_hint_ready_gladia_direct');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else if (mode === 'proxy') {
    keyHint.textContent = t('p_hint_ready_gladia_proxy');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else {
    keyHint.textContent = t('p_hint_ready_whisper');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  }
}

// ── Backup ────────────────────────────────────────────────────────────────────
// Export/import live in their own extension TAB (backup.html): Firefox closes this
// popup the moment a file picker opens, which killed the import mid-flight.

document.getElementById('openBackupBtn').addEventListener('click', () => {
  // A small standalone popup window (no tab strip / URL bar) — file pickers work
  // fine from real windows, unlike from this browser-action panel.
  browser.windows.create({
    url: browser.runtime.getURL('src/popup/backup.html'),
    type: 'popup',
    width: 520,
    height: 400,
  });
  window.close();
});

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

  const anthropicKey = anthropicEl.value.trim();
  const proxyUrl = proxyUrlEl.value.trim();
  const proxyToken = proxyTokenEl.value.trim();
  const gladiaKey = gladiaEl.value.trim();

  if (mode === 'apikey' && !anthropicKey) {
    keyHint.textContent = t('p_hint_enter_key');
    keyHint.className = 'key-hint error';
    return;
  }

  if (mode === 'proxy' && !proxyUrl) {
    keyHint.textContent = t('p_hint_enter_proxy');
    keyHint.className = 'key-hint error';
    return;
  }

  await browser.storage.local.set({ anthropicKey, proxyUrl, proxyToken, gladiaKey, sourceLanguage: sourceLanguageEl.value, participants: participantsEl.value.trim(), connectionMode: mode, aiProvider, aiProviderChain: currentChain(), uiLanguage: getUiLang() });

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
});
