// backup.js — full-tab backup manager.
// Lives in its own extension tab (not the popup): Firefox closes browser-action
// popups the moment a file picker opens, which killed the import mid-flight.

const exportBackupBtn = document.getElementById('exportBackupBtn');
const importBackupBtn = document.getElementById('importBackupBtn');
const importBackupFile = document.getElementById('importBackupFile');
const backupIncludeCreds = document.getElementById('backupIncludeCreds');
const backupHintEl = document.getElementById('backupHint');

// What a backup may contain. Credentials only go in when the checkbox is ticked,
// and on import a file is never trusted: only these keys, type-checked, are applied.
const BACKUP_SETTINGS_KEYS = ['sourceLanguage', 'participants', 'aiProvider', 'aiProviderChain', 'connectionMode', 'feedbackNegative', 'feedbackPositive', 'feedbackRules', 'feedbackSinceDistill', 'uiLanguage', 'understoodLanguages', 'webSearchLimit'];
const BACKUP_CRED_KEYS = ['proxyUrl', 'proxyToken', 'gladiaKey', 'anthropicKey'];
const BACKUP_ARRAY_KEYS = ['feedbackNegative', 'feedbackPositive', 'feedbackRules', 'understoodLanguages', 'aiProviderChain'];

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.title = 'NewsPal — ' + t('p_lbl_backup');
}

browser.storage.local.get('uiLanguage').then(d => {
  setUiLang(d.uiLanguage || defaultUiLanguage());
  applyI18n();
});

function backupHint(text, ok) {
  backupHintEl.textContent = text;
  backupHintEl.className = 'key-hint ' + (ok ? 'ok' : 'error');
}

exportBackupBtn.addEventListener('click', async () => {
  const keys = backupIncludeCreds.checked
    ? [...BACKUP_SETTINGS_KEYS, ...BACKUP_CRED_KEYS]
    : BACKUP_SETTINGS_KEYS;
  const data = await browser.storage.local.get(keys);
  const payload = {
    app: 'intruth-backup', // internal marker unchanged (NewsPal rename) so old backups keep importing
    version: 1,
    exportedAt: new Date().toISOString(),
    includesCredentials: backupIncludeCreds.checked,
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'newspal-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupHint(backupIncludeCreds.checked ? t('p_backup_done_creds') : t('p_backup_done'), true);
});

importBackupBtn.addEventListener('click', () => importBackupFile.click());

importBackupFile.addEventListener('change', async () => {
  const file = importBackupFile.files && importBackupFile.files[0];
  importBackupFile.value = '';
  if (!file) return;
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { backupHint(t('p_backup_bad_json'), false); return; }
  if (!payload || payload.app !== 'intruth-backup' || typeof payload.data !== 'object' || payload.data === null) {
    backupHint(t('p_backup_not_ours'), false);
    return;
  }
  const clean = {};
  for (const key of [...BACKUP_SETTINGS_KEYS, ...BACKUP_CRED_KEYS]) {
    if (!(key in payload.data)) continue;
    const v = payload.data[key];
    if (BACKUP_ARRAY_KEYS.includes(key)) {
      if (Array.isArray(v)) clean[key] = v.map(s => String(s).trim()).filter(Boolean);
    } else if (key === 'feedbackSinceDistill') {
      if (Number.isInteger(v) && v >= 0) clean[key] = v;
    } else if (typeof v === 'string') {
      const s = v.trim();
      // An empty value in the file must never wipe an existing credential here.
      if (s || !BACKUP_CRED_KEYS.includes(key)) clean[key] = s;
    }
  }
  if (!Object.keys(clean).length) {
    backupHint(t('p_backup_empty'), false);
    return;
  }
  await browser.storage.local.set(clean);
  // The background syncs live via storage.onChanged; the popup reads storage fresh
  // each time it opens — nothing else to do.
  if (clean.uiLanguage) { setUiLang(clean.uiLanguage); applyI18n(); }
  backupHint(t('b_import_ok'), true);
});
