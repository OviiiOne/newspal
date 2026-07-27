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
  { id: 'gemini', name: 'Gemini', free: false },
  { id: 'claude', name: 'Claude', free: false },
];
const DEFAULT_CHAIN = ['groq', 'cerebras', 'mistral'];
// Full display order with an enabled flag per provider (enabled ones lead, in chain order).
let providerOrder = [];

// ── UI language (bilingual edition) ──────────────────────────────────────────
// One setting drives the popup/overlay texts AND the language the AI writes in.

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  uiLangEsBtn.classList.toggle('active', getUiLang() === 'es');
  uiLangEnBtn.classList.toggle('active', getUiLang() === 'en');
  setActive(isActive); // refresh status + toggle-button texts
}

// Rebuild both language selects with labels in the current UI language,
// preserving the current selections.
function buildLanguageSelects(selectedSource, selectedUnderstood) {
  const source = selectedSource !== undefined ? selectedSource : sourceLanguageEl.value || 'auto';
  const understood = selectedUnderstood !== undefined
    ? selectedUnderstood
    : [...understoodEl.selectedOptions].map(o => o.value);

  sourceLanguageEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('p_opt_auto');
  sourceLanguageEl.appendChild(auto);
  for (const l of EXT_LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l[getUiLang()] || l.en;
    sourceLanguageEl.appendChild(o);
  }
  sourceLanguageEl.value = source;

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

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(up);
    row.appendChild(down);
    providerChainEl.appendChild(row);
  });
}

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
