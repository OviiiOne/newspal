// settings.js — the popup's settings view (⚙): everything you configure once and forget:
// credentials, the model queue, the languages you understand, the learned rules and the
// backup. The main view keeps only what you touch per session. Every field saves itself
// on change, so there is no Save button and popup.js just follows storage.onChanged.
// Wrapped so its names don't clash with popup.js, which shares the page.

(() => {
const anthropicEl = document.getElementById('anthropicKey');
const proxyUrlEl = document.getElementById('proxyUrl');
const proxyTokenEl = document.getElementById('proxyToken');
const gladiaEl = document.getElementById('gladiaKey');
const understoodEl = document.getElementById('understoodLanguages');
const feedbackRulesEl = document.getElementById('feedbackRules');
const keyHint = document.getElementById('settingsKeyHint');
const modeApiKeyBtn = document.getElementById('modeApiKey');
const modeProxyBtn = document.getElementById('modeProxy');
const apiKeyFields = document.getElementById('apiKeyFields');
const proxyFields = document.getElementById('proxyFields');
const providerChainEl = document.getElementById('providerChain');
const uiLangEsBtn = document.getElementById('uiLangEs');
const uiLangEnBtn = document.getElementById('uiLangEn');
const proxyStatusLine = document.getElementById('proxyStatusLine');

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
}

// Rebuild the understood-languages list with labels in the current UI language.
function buildUnderstoodSelect(selectedUnderstood) {
  const understood = selectedUnderstood !== undefined
    ? selectedUnderstood
    : [...understoodEl.selectedOptions].map(o => o.value);

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
  buildUnderstoodSelect(understoodExplicit ? undefined : defaultUnderstoodLanguages(getUiLang()));
  applyI18n();
  updateHint();
}

uiLangEsBtn.addEventListener('click', () => switchUiLang('es'));
uiLangEnBtn.addEventListener('click', () => switchUiLang('en'));

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

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'gladiaKey', 'connectionMode', 'aiProvider', 'aiProviderChain', 'feedbackRules', 'uiLanguage', 'understoodLanguages']).then(data => {
  setUiLang(data.uiLanguage || defaultUiLanguage());
  understoodExplicit = Array.isArray(data.understoodLanguages) && data.understoodLanguages.length > 0;
  buildUnderstoodSelect(understoodExplicit ? data.understoodLanguages : defaultUnderstoodLanguages(getUiLang()));

  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.proxyUrl) { proxyUrlEl.value = data.proxyUrl; proxyUrlEl.classList.add('saved'); }
  if (data.proxyToken) { proxyTokenEl.value = data.proxyToken; proxyTokenEl.classList.add('saved'); }
  if (data.gladiaKey) { gladiaEl.value = data.gladiaKey; gladiaEl.classList.add('saved'); }
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

understoodEl.addEventListener('change', () => {
  const langs = [...understoodEl.selectedOptions].map(o => o.value);
  understoodExplicit = langs.length > 0;
  browser.storage.local.set({ understoodLanguages: langs });
});

// Learned rules: one per line; the background picks up edits via storage.onChanged.
feedbackRulesEl.addEventListener('input', () => {
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

// Saved on every keystroke, not only on 'change': the popup closes the moment you click
// outside it, and a half-typed value would otherwise be lost with it.
[anthropicEl, proxyUrlEl, proxyTokenEl, gladiaEl].forEach(el => {
  el.addEventListener('input', () => {
    browser.storage.local.set({ [el.id]: el.value.trim() });
    el.classList.toggle('saved', !!el.value.trim());
    updateHint();
  });
});

function updateHint() {
  const hasClaude = mode === 'proxy' ? proxyUrlEl.value.trim() : anthropicEl.value.trim();
  const hasGladia = gladiaEl.value.trim();

  if (!hasClaude) {
    keyHint.textContent = mode === 'proxy' ? t('p_hint_enter_proxy') : t('p_hint_enter_key');
    keyHint.className = 'key-hint error';
  } else if (hasGladia) {
    keyHint.textContent = t('p_hint_ready_gladia_direct');
    keyHint.className = 'key-hint ok';
  } else if (mode === 'proxy') {
    keyHint.textContent = t('p_hint_ready_gladia_proxy');
    keyHint.className = 'key-hint ok';
  } else {
    keyHint.textContent = t('p_hint_ready_whisper');
    keyHint.className = 'key-hint ok';
  }
}

// ── Proxy status (checked by the background; see refreshProxyStatus) ────────

let proxyStatus = { state: 'off' };

function renderProxyStatus() {
  const s = proxyStatus.state;
  proxyStatusLine.textContent = s === 'checking' ? t('p_checking_proxy')
    : s === 'ok' ? t('p_proxy_ok')
    : s === 'bad' ? proxyProblemText(proxyStatus)
    : '';
  proxyStatusLine.className = 'key-hint' + (s === 'ok' ? ' ok' : s === 'bad' ? ' error' : '');
}

browser.storage.local.get('proxyStatus').then(d => {
  if (d.proxyStatus) proxyStatus = d.proxyStatus;
  renderProxyStatus();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.proxyStatus) {
    proxyStatus = changes.proxyStatus.newValue || { state: 'off' };
    renderProxyStatus();
  }
  if (changes.uiLanguage) renderProxyStatus();
});

// ── Backup ────────────────────────────────────────────────────────────────────
// Export/import live in their own window (backup.html): Firefox closes the browser-action
// popup the moment a file picker opens, which killed the import mid-flight. Settings are
// part of the popup too, so the backup still needs that separate window.

document.getElementById('openBackupBtn').addEventListener('click', () => {
  browser.windows.create({
    url: browser.runtime.getURL('src/popup/backup.html'),
    type: 'popup',
    width: 520,
    height: 400,
  });
});
})();
