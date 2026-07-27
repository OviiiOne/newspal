// lang.js — bilingual (ES/EN) edition.
// ONE shared module with every user-facing string and the language-dependent prompt
// fragments. The same setting (`uiLanguage`) drives both the UI language and the
// language the AI writes in (key points, summary, learned rules). Two FIXED languages
// by design — Spanish (the original) and English (universal) — instead of full i18n.
// Loaded FIRST in every context (background, content scripts, popup): the other
// scripts share this global scope and call setUiLang()/t() directly.

const UI_LANGS = ['es', 'en'];
let UI_LANG = 'es';

function setUiLang(l) { UI_LANG = UI_LANGS.includes(l) ? l : 'es'; }
function getUiLang() { return UI_LANG; }

// Default when the user never chose: follow the browser's own UI language.
function defaultUiLanguage() {
  try {
    return (browser.i18n.getUILanguage() || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

// The 14 transcription languages: popup selector labels (per UI language) and the
// English names the prompts use.
const EXT_LANGUAGES = [
  { code: 'es', name: 'Spanish',    es: 'Español',                 en: 'Spanish (Español)' },
  { code: 'en', name: 'English',    es: 'Inglés (English)',        en: 'English' },
  { code: 'fr', name: 'French',     es: 'Francés (Français)',      en: 'French (Français)' },
  { code: 'de', name: 'German',     es: 'Alemán (Deutsch)',        en: 'German (Deutsch)' },
  { code: 'it', name: 'Italian',    es: 'Italiano',                en: 'Italian (Italiano)' },
  { code: 'pt', name: 'Portuguese', es: 'Portugués (Português)',   en: 'Portuguese (Português)' },
  { code: 'ru', name: 'Russian',    es: 'Ruso (Русский)',          en: 'Russian (Русский)' },
  { code: 'uk', name: 'Ukrainian',  es: 'Ucraniano (Українська)',  en: 'Ukrainian (Українська)' },
  { code: 'tr', name: 'Turkish',    es: 'Turco (Türkçe)',          en: 'Turkish (Türkçe)' },
  { code: 'ar', name: 'Arabic',     es: 'Árabe (العربية)',          en: 'Arabic (العربية)' },
  { code: 'he', name: 'Hebrew',     es: 'Hebreo (עברית)',           en: 'Hebrew (עברית)' },
  { code: 'fa', name: 'Persian',    es: 'Persa / Farsi (فارسی)',    en: 'Persian / Farsi (فارسی)' },
  { code: 'zh', name: 'Chinese',    es: 'Chino (中文)',             en: 'Chinese (中文)' },
  { code: 'ja', name: 'Japanese',   es: 'Japonés (日本語)',          en: 'Japanese (日本語)' },
];

function langName(code) {
  const l = EXT_LANGUAGES.find(x => x.code === code);
  return l ? l.name : '';
}

// Which languages skip translation when no explicit choice is stored.
function defaultUnderstoodLanguages(uiLang) {
  return (uiLang || UI_LANG) === 'es' ? ['es', 'en'] : ['en'];
}

// Display names for the LLM providers (brand names, same in both languages). Used to
// show which model is active in the toast, transcript marker and key-point tags.
const PROVIDER_LABELS = { groq: 'Groq', cerebras: 'Cerebras', mistral: 'Mistral', gemini: 'Gemini', claude: 'Claude' };
function providerLabel(id) { return PROVIDER_LABELS[id] || (id ? String(id) : ''); }

// ── Prompt fragments (the prompts themselves stay in English) ────────────────

const PROMPT_LANG = {
  es: {
    name: 'Spanish',
    cats: 'ANUNCIO, CIFRA, COMPROMISO, DECLARACION, CITA, POLITICA',
    catOther: 'OTRO',
    catExamples: 'GEOPOLITICA, SEGURIDAD, ECONOMIA, JUSTICIA',
    otherSpeaker: 'Otro',
    verifiedMarker: 'Verificado',
    verifHeading: 'Verificaciones:',
    ruleExamples: '"Nunca extraigas halagos personales entre dirigentes", "Captura siempre cifras de gasto militar"',
  },
  en: {
    name: 'English',
    cats: 'ANNOUNCEMENT, FIGURE, COMMITMENT, STATEMENT, QUOTE, POLICY',
    catOther: 'OTHER',
    catExamples: 'GEOPOLITICS, SECURITY, ECONOMY, JUSTICE',
    otherSpeaker: 'Other',
    verifiedMarker: 'Verified',
    verifHeading: 'Verifications:',
    ruleExamples: '"Never extract personal flattery between leaders", "Always capture military-spending figures"',
  },
};

function promptLang() { return PROMPT_LANG[UI_LANG] || PROMPT_LANG.es; }

// ── Key-point categories / verdict labels ────────────────────────────────────
// Codes from BOTH languages are always recognised, so sessions and exports keep
// rendering correctly after a language switch (old Spanish codes included).

const KP_CATEGORY_META = {
  ANUNCIO:      { label: 'Anuncio',      color: '#3b82f6' },
  ANNOUNCEMENT: { label: 'Announcement', color: '#3b82f6' },
  CIFRA:        { label: 'Cifra',        color: '#8b5cf6' },
  FIGURE:       { label: 'Figure',       color: '#8b5cf6' },
  COMPROMISO:   { label: 'Compromiso',   color: '#10b981' },
  COMMITMENT:   { label: 'Commitment',   color: '#10b981' },
  DECLARACION:  { label: 'Declaración',  color: '#f59e0b' },
  STATEMENT:    { label: 'Statement',    color: '#f59e0b' },
  CITA:         { label: 'Cita',         color: '#06b6d4' },
  QUOTE:        { label: 'Quote',        color: '#06b6d4' },
  POLITICA:     { label: 'Política',     color: '#ef4444' },
  POLICY:       { label: 'Policy',       color: '#ef4444' },
  OTRO:         { label: 'Otro',         color: '#6b7280' },
  OTHER:        { label: 'Other',        color: '#6b7280' },
};

const VERDICT_I18N = {
  es: { 'TRUE': 'Verdadero', 'SUBSTANTIALLY TRUE': 'Mayormente cierto', 'FALSE': 'Falso', 'MISLEADING': 'Engañoso', 'UNVERIFIABLE': 'No verificable' },
  en: { 'TRUE': 'True', 'SUBSTANTIALLY TRUE': 'Substantially true', 'FALSE': 'False', 'MISLEADING': 'Misleading', 'UNVERIFIABLE': 'Unverifiable' },
};

const CONF_I18N = {
  es: { HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja' },
  en: { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' },
};

function verdictLabel(v) { return (VERDICT_I18N[UI_LANG] || VERDICT_I18N.es)[v] || v; }
function confLabel(c) { return (CONF_I18N[UI_LANG] || CONF_I18N.es)[c] || c; }

// ── UI strings ────────────────────────────────────────────────────────────────

const I18N = {
  es: {
    // Popup
    p_status_inactive: 'Inactivo',
    p_status_active: 'En directo • Análisis activo',
    p_btn_start: 'Iniciar análisis',
    p_btn_stop: 'Detener análisis',
    p_lbl_anthropic: 'API Key de Anthropic',
    p_lbl_proxy_url: 'URL del proxy',
    p_lbl_proxy_token: 'Token del proxy',
    p_ph_proxy_token: 'el valor de PROXY_TOKEN',
    p_lbl_ai_model: 'Modelos de IA (cola)',
    p_provider_chain_hint: 'Se usan en este orden: si uno falla o se queda sin tokens, pasa al siguiente. Marca los que quieras usar y ordénalos con ▲▼. Groq, Cerebras y Mistral son gratis; Gemini y Claude, de pago.',
    p_proxy_hint: 'Groq: gratis (con límites de velocidad). Gemini/Claude: de pago.',
    p_lbl_gladia: 'API Key de Gladia',
    p_optional: '(opcional)',
    p_ph_gladia: 'tu clave de gladia...',
    p_gladia_hint: 'Gratis 10h/mes en gladia.io. En modo Proxy puedes dejarlo vacío: la clave de Gladia va en el servidor. Sin clave ni proxy usa Whisper local (~150MB, 1ª vez). Para idiomas no europeos (árabe, hebreo, persa…) se recomienda Gladia.',
    p_lbl_source_lang: 'Idioma de la rueda de prensa',
    p_source_lang_hint: 'El idioma que se HABLA en el vídeo. Ponlo en Automático o en el idioma real; si eliges otro, la transcripción saldrá en ese idioma equivocado.',
    p_opt_auto: 'Detección automática',
    p_lbl_understood: 'Idiomas que entiendes (no traducir)',
    p_understood_hint: 'Los idiomas marcados solo se transcriben; los demás se traducen. (Ctrl+clic para marcar varios.)',
    p_lbl_participants: 'Participantes',
    p_ph_participants: 'Ej: Trump, Rutte',
    p_participants_hint: 'Quién habla en la rueda de prensa, separado por comas. La IA atribuirá los puntos clave solo a estos nombres.',
    p_lbl_rules: 'Reglas aprendidas',
    p_editable: '(editable)',
    p_ph_rules: 'Aún no hay reglas. Se crean solas a partir de tus 👎 y ⭐.',
    p_rules_hint: 'La IA convierte tus 👎 (descartar) y ⭐ (interesante) en reglas fijas que aplica siempre al elegir puntos clave. Una regla por línea: puedes editarlas, añadir nuevas o borrar las que no te convenzan.',
    p_lbl_backup: 'Copia de seguridad',
    p_btn_export: '↓ Exportar',
    p_btn_import: '↑ Importar',
    p_chk_creds: 'Incluir credenciales (URL y token del proxy, claves API)',
    p_backup_hint: 'Guarda o restaura en un archivo los ajustes, participantes y todo lo aprendido (👎/⭐ y reglas). Con la casilla marcada incluye también las credenciales: guarda ese archivo en un sitio privado.',
    p_backup_open: '↗ Exportar / importar…',
    p_backup_open_hint: 'Se abre en una ventana pequeña (este panel se cierra solo al elegir archivos, así que la copia se gestiona allí).',
    b_import_ok: 'Copia restaurada correctamente. Los cambios ya están aplicados.',
    p_firefox_note: 'Si la página no tiene un vídeo propio reproduciéndose, al pulsar Iniciar elige un dispositivo de audio del sistema (loopback, p. ej. "CABLE Output" o "Stereo Mix"), no el micrófono. Gladia: tiempo real. Sin Gladia: Whisper local (~5s de retardo).',
    p_hint_enter_proxy: 'Introduce la URL del proxy.',
    p_hint_enter_key: 'Introduce tu API key de Anthropic.',
    p_hint_ready_gladia_direct: 'Listo — transcripción con Gladia (clave directa).',
    p_hint_ready_gladia_proxy: 'Listo — Gladia a través del proxy (clave en el servidor).',
    p_hint_ready_whisper: 'Listo — Whisper local (audio de pestaña, ~5s de retardo).',
    p_backup_done_creds: 'Copia exportada (CON credenciales — guárdala en un sitio privado).',
    p_backup_done: 'Copia exportada (sin credenciales).',
    p_backup_bad_json: 'El archivo no es un JSON válido.',
    p_backup_not_ours: 'El archivo no parece una copia de NewsPal.',
    p_backup_empty: 'La copia no contiene datos reconocibles.',
    p_start_failed: 'Fallo: ',
    p_error: 'Error: ',
    // Overlay
    ov_summary_btn: '🧾 Resumen',
    ov_summary_btn_title: 'Generar resumen',
    ov_export_btn: '↓ Exportar',
    ov_export_title: 'Exportar sesión',
    ov_transcript: 'Transcripción',
    ov_keypoints: 'Puntos clave',
    ov_empty: 'Los puntos clave aparecerán aquí…',
    ov_participants: '👥 Participantes:',
    ov_part_ph: '+ nombre (coma para varios)',
    ov_part_edit_title: 'Clic para editar',
    ov_part_del_title: 'Quitar',
    ov_part_edit_prompt: 'Editar nombre del participante:',
    ov_interesting: '⭐ Interesante',
    ov_verify: '✓ Verificar',
    ov_verifying: '⟳ Verificando…',
    ov_verify_disabled_title: 'Verificación no disponible por ahora: la búsqueda web no funciona en el plan gratuito de Groq',
    ov_discard_title: 'No relevante — descartar y aprender',
    ov_reinforce_title: 'Punto acertado — reforzar y aprender',
    ov_reinforced_title: 'Reforzado ✓',
    ov_edit_title: 'Corregir el texto de este punto',
    ov_save: 'Guardar',
    ov_cancel: 'Cancelar',
    ov_model_changed: 'Modelo activo:',
    ov_via: 'vía',
    ov_no_verdict: 'No se pudo verificar (búsqueda web no disponible). Inténtalo de nuevo.',
    ov_confidence: 'confianza',
    ov_source: 'Fuente',
    ov_summary_title: 'Resumen',
    ov_summary_loading: 'Generando resumen…',
    ov_summary_failed: 'No se pudo generar el resumen.',
    ov_nothing_to_summarize: 'Aún no hay contenido para resumir.',
    ov_resize_title: 'Arrastra para redimensionar',
    ov_pipeline_error: 'Se produjo un error en el procesamiento.',
    ov_session_resumed: 'Sesión recuperada tras recargar la página.',
    // Audio capture
    ac_perm_denied: 'Permiso de audio denegado. Permite la entrada de audio para esta página.',
    ac_capture_fail: 'Fallo al capturar audio: ',
    ac_no_audio: 'No se detectó audio. Asegúrate de que el vídeo se está reproduciendo, o elige un dispositivo de audio del sistema.',
    ac_capturing: 'Capturando {src} · Transcripción: {eng}',
    ac_src_video: 'audio del vídeo',
    ac_src_device: 'dispositivo de audio',
    ac_gladia_proxy: 'Gladia (proxy)',
    ac_gladia_direct: 'Gladia (clave directa)',
    ac_whisper: 'Whisper local',
    ac_gladia_failed_status: 'Gladia{via} falló — estado {status}.',
    ac_via_proxy: ' por proxy',
    ac_no_session_url: 'Gladia no devolvió URL de sesión. Revisa la clave de Gladia en Railway.',
    ac_connected: 'Conectado a Gladia — escuchando, esperando que alguien hable…',
    ac_fallback_whisper: 'Gladia falló. Cambiando a Whisper local…',
    ac_auth_failed: 'Gladia: autenticación fallida (código {code}). Revisa la clave de Gladia en Railway.',
    ac_reconnecting: 'Gladia desconectado (código {code}{reason}) — reconectando…',
    ac_connect_error: 'No se pudo conectar con Gladia/proxy: {msg} (¿URL del proxy correcta? ¿la web bloquea la conexión?).',
    ac_whisper_loading: 'Cargando modelo Whisper local (~150MB, solo la 1ª vez)…',
    ac_whisper_load_error: 'No se pudo cargar el modelo Whisper: ',
    ac_whisper_ready: 'Whisper cargado — transcribiendo en local (sin detección de orador).',
    ac_recaptured: 'Captura de audio reanudada tras una interrupción del vídeo (buffering).',
    // Export / report
    ex_nothing: 'No hay nada que exportar todavía.',
    ex_report: 'Informe',
    ex_summary: 'Resumen',
    ex_keypoints: 'Puntos clave',
    ex_transcript: 'Transcripción',
    ex_verified: 'Verificados',
    ex_source: 'Fuente',
    ex_title_label: 'Título:',
    ex_kp_label: 'Puntos clave:',
    ex_tr_label: 'Transcripción:',
  },
  en: {
    // Popup
    p_status_inactive: 'Inactive',
    p_status_active: 'Live • Fact-checking active',
    p_btn_start: 'Start Fact-Checking',
    p_btn_stop: 'Stop Fact-Checking',
    p_lbl_anthropic: 'Anthropic API Key',
    p_lbl_proxy_url: 'Proxy URL',
    p_lbl_proxy_token: 'Proxy token',
    p_ph_proxy_token: 'the PROXY_TOKEN value',
    p_lbl_ai_model: 'AI models (queue)',
    p_provider_chain_hint: 'Used in this order: if one fails or runs out of tokens, it falls back to the next. Tick the ones you want and reorder with ▲▼. Groq, Cerebras and Mistral are free; Gemini and Claude are paid.',
    p_proxy_hint: 'Groq: free (rate-limited). Gemini/Claude: paid.',
    p_lbl_gladia: 'Gladia API Key',
    p_optional: '(optional)',
    p_ph_gladia: 'your gladia key...',
    p_gladia_hint: 'Free 10h/month at gladia.io. In Proxy mode you can leave it empty: the Gladia key lives on the server. Without a key or proxy, a local Whisper model is used (~150MB, first time only). For non-European languages (Arabic, Hebrew, Persian…) Gladia is recommended.',
    p_lbl_source_lang: 'Event language',
    p_source_lang_hint: 'The language SPOKEN in the video. Use Auto-detect or the real language; if you pick another, the transcript will come out in that wrong language.',
    p_opt_auto: 'Auto-detect',
    p_lbl_understood: "Languages you understand (don't translate)",
    p_understood_hint: 'Selected languages are only transcribed; everything else gets translated. (Ctrl+click to select several.)',
    p_lbl_participants: 'Participants',
    p_ph_participants: 'E.g.: Trump, Rutte',
    p_participants_hint: 'Who speaks at the event, comma-separated. The AI will attribute key points only to these names.',
    p_lbl_rules: 'Learned rules',
    p_editable: '(editable)',
    p_ph_rules: 'No rules yet. They are created automatically from your 👎 and ⭐.',
    p_rules_hint: 'The AI turns your 👎 (discard) and ⭐ (interesting) marks into fixed rules applied every time key points are chosen. One rule per line: edit them, add your own or delete any you dislike.',
    p_lbl_backup: 'Backup',
    p_btn_export: '↓ Export',
    p_btn_import: '↑ Import',
    p_chk_creds: 'Include credentials (proxy URL & token, API keys)',
    p_backup_hint: 'Save or restore settings, participants and everything learned (👎/⭐ and rules) to a file. With the box ticked it also includes credentials: keep that file somewhere private.',
    p_backup_open: '↗ Export / import…',
    p_backup_open_hint: 'Opens in a small window (this panel closes itself when a file picker opens, so backups are managed there).',
    b_import_ok: 'Backup restored successfully. The changes are already applied.',
    p_firefox_note: 'If the page has no playing video of its own, when you press Start pick a system-audio device (loopback, e.g. "CABLE Output" or "Stereo Mix"), not the microphone. Gladia: real time. Without Gladia: local Whisper (~5s delay).',
    p_hint_enter_proxy: 'Enter your proxy URL.',
    p_hint_enter_key: 'Enter your Anthropic API key.',
    p_hint_ready_gladia_direct: 'Ready — Gladia transcription (direct key).',
    p_hint_ready_gladia_proxy: 'Ready — Gladia through the proxy (key on the server).',
    p_hint_ready_whisper: 'Ready — local Whisper (tab audio, ~5s delay).',
    p_backup_done_creds: 'Backup exported (WITH credentials — keep it somewhere private).',
    p_backup_done: 'Backup exported (without credentials).',
    p_backup_bad_json: 'The file is not valid JSON.',
    p_backup_not_ours: 'The file does not look like a NewsPal backup.',
    p_backup_empty: 'The backup contains no recognizable data.',
    p_start_failed: 'Failed: ',
    p_error: 'Error: ',
    // Overlay
    ov_summary_btn: '🧾 Summary',
    ov_summary_btn_title: 'Generate summary',
    ov_export_btn: '↓ Export',
    ov_export_title: 'Export session',
    ov_transcript: 'Transcript',
    ov_keypoints: 'Key points',
    ov_empty: 'Key points will appear here…',
    ov_participants: '👥 Participants:',
    ov_part_ph: '+ name (comma for several)',
    ov_part_edit_title: 'Click to edit',
    ov_part_del_title: 'Remove',
    ov_part_edit_prompt: "Edit participant's name:",
    ov_interesting: '⭐ Interesting',
    ov_verify: '✓ Verify',
    ov_verifying: '⟳ Verifying…',
    ov_verify_disabled_title: "Verification unavailable for now: web search doesn't work on Groq's free tier",
    ov_discard_title: 'Not relevant — discard and learn',
    ov_reinforce_title: 'Good point — reinforce and learn',
    ov_reinforced_title: 'Reinforced ✓',
    ov_edit_title: 'Correct this point’s text',
    ov_save: 'Save',
    ov_cancel: 'Cancel',
    ov_model_changed: 'Active model:',
    ov_via: 'via',
    ov_no_verdict: 'Could not verify (web search unavailable). Try again.',
    ov_confidence: 'confidence',
    ov_source: 'Source',
    ov_summary_title: 'Summary',
    ov_summary_loading: 'Generating summary…',
    ov_summary_failed: 'Could not generate the summary.',
    ov_nothing_to_summarize: 'Nothing to summarize yet.',
    ov_resize_title: 'Drag to resize',
    ov_pipeline_error: 'A processing error occurred.',
    ov_session_resumed: 'Session recovered after the page reload.',
    // Audio capture
    ac_perm_denied: 'Audio permission denied. Allow audio input for this page.',
    ac_capture_fail: 'Audio capture failed: ',
    ac_no_audio: 'No audio detected. Make sure the video is playing, or pick a system-audio device.',
    ac_capturing: 'Capturing {src} · Transcription: {eng}',
    ac_src_video: 'video audio',
    ac_src_device: 'audio device',
    ac_gladia_proxy: 'Gladia (proxy)',
    ac_gladia_direct: 'Gladia (direct key)',
    ac_whisper: 'Local Whisper',
    ac_gladia_failed_status: 'Gladia{via} failed — status {status}.',
    ac_via_proxy: ' via proxy',
    ac_no_session_url: 'Gladia returned no session URL. Check the Gladia key on Railway.',
    ac_connected: 'Connected to Gladia — listening, waiting for someone to speak…',
    ac_fallback_whisper: 'Gladia failed. Switching to local Whisper…',
    ac_auth_failed: 'Gladia: authentication failed (code {code}). Check the Gladia key on Railway.',
    ac_reconnecting: 'Gladia disconnected (code {code}{reason}) — reconnecting…',
    ac_connect_error: "Couldn't connect to Gladia/proxy: {msg} (proxy URL correct? does the site block the connection?).",
    ac_whisper_loading: 'Loading local Whisper model (~150MB, first time only)…',
    ac_whisper_load_error: "Couldn't load the Whisper model: ",
    ac_whisper_ready: 'Whisper loaded — transcribing locally (no speaker detection).',
    ac_recaptured: 'Audio capture resumed after a video interruption (buffering).',
    // Export / report
    ex_nothing: 'Nothing to export yet.',
    ex_report: 'Report',
    ex_summary: 'Summary',
    ex_keypoints: 'Key points',
    ex_transcript: 'Transcript',
    ex_verified: 'Verified',
    ex_source: 'Source',
    ex_title_label: 'Title:',
    ex_kp_label: 'Key points:',
    ex_tr_label: 'Transcript:',
  },
};

function t(key) {
  const d = I18N[UI_LANG] || I18N.es;
  if (key in d) return d[key];
  if (key in I18N.es) return I18N.es[key];
  return key;
}

function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars) ? vars[k] : m);
}
