const express = require('express');
const app = express();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';
const GLADIA_KEY = process.env.GLADIA_API_KEY || '';

// Pinning a model id is a trap: hosted models get RETIRED without notice, the API then
// answers "the model does not exist or you do not have access to it", and because the
// client walks a fallback chain a single retirement can break every provider at once.
// So the model is DISCOVERED instead — each provider's GET /v1/models lists exactly what
// this key may call, and we pick the best one there. An env var still overrides it
// (GROQ_MODEL / MISTRAL_MODEL / CEREBRAS_MODEL / GEMINI_MODEL) to pin one on purpose.
const MODEL_OVERRIDES = {
  groq: process.env.GROQ_MODEL || '',
  mistral: process.env.MISTRAL_MODEL || '',
  cerebras: process.env.CEREBRAS_MODEL || '',
  gemini: process.env.GEMINI_MODEL || '',
};
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const PORT = process.env.PORT || 3000;

if (!ANTHROPIC_KEY && !GEMINI_KEY && !GROQ_KEY && !MISTRAL_KEY && !CEREBRAS_KEY) {
  console.error('At least one of ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY or CEREBRAS_API_KEY is required');
  process.exit(1);
}

if (!PROXY_TOKEN) {
  console.warn('WARNING: PROXY_TOKEN not set — the proxy is OPEN to anyone with the URL. Set PROXY_TOKEN to require a secret.');
}

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-proxy-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Shared-secret gate: a public URL alone can't use the proxy without the token.
// (CORS does not stop direct calls — this does.) /health stays open for checks.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (PROXY_TOKEN && req.get('x-proxy-token') !== PROXY_TOKEN) {
    return res.status(401).json({ error: { message: 'Unauthorized — missing or invalid proxy token' } });
  }
  next();
});

// Gemini: convert Claude-style messages to Gemini format
function toGeminiRequest(system, messages, temperature, maxTokens, grounded) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const req = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature: temperature ?? 0,
      maxOutputTokens: Math.min(maxTokens || 768, 2048),
    },
  };
  // Let Gemini search Google itself and ground the answer in real results.
  if (grounded) req.tools = [{ google_search: {} }];
  return req;
}

// Gemini: convert response to Claude-compatible format (+ grounding sources)
function fromGeminiResponse(data, model) {
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('') || '';
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const sources = chunks.map(c => c.web?.uri).filter(Boolean);
  return {
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    sources,
  };
}

async function handleClaude(body) {
  const { model, max_tokens, temperature, system, messages } = body;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: Math.min(max_tokens || 768, 2048),
      temperature: temperature ?? 0,
      system: system || '',
      messages,
    }),
  });
  return { status: response.status, data: await response.json() };
}

// Gemini speaks its own dialect but gets the same treatment as the rest: the model comes
// from Google's own catalogue and a failing one falls through to the next.
async function handleGemini(body) {
  const { max_tokens, temperature, system, messages, grounded } = body;
  const geminiBody = toGeminiRequest(system, messages, temperature, max_tokens, grounded);

  return withModelFallback('gemini', 'Gemini', async (model) => {
    const url = GEMINI_BASE + '/models/' + encodeURIComponent(model)
      + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    const raw = await response.json().catch(() => ({}));
    const data = response.ok ? fromGeminiResponse(raw, model) : null;
    return {
      ok: response.ok,
      status: response.status,
      message: raw?.error?.message || '',
      text: data ? data.content[0].text.trim() : '',
      result: { status: 200, data },
    };
  });
}

// ── Model discovery ───────────────────────────────────────────────────────────
// Groq, Mistral and Cerebras all expose the OpenAI-style GET /v1/models, which lists
// what THIS key can actually call right now. We list it, drop everything that isn't a
// general chat model, and RANK the rest by a per-provider preference order.
//
// The result is a ranked list, not a single pick, because the listing says which models
// exist but nothing about what they cost us: rate limits are not in the API, only in the
// provider's dashboard. A brand-new flagship can turn up with a rate limit so low it is
// useless (Mistral's own free tier has shipped a model at 20k tokens/minute). So the
// fallback runs at the MODEL level first — best model, next model, next — and only when
// a provider has nothing left does the client's chain move on to the next provider.

const OPENAI_COMPAT = {
  groq: {
    base: 'https://api.groq.com/openai/v1', key: GROQ_KEY, label: 'Groq',
    // Only reachable on a paid tier — see the free-tier 413 note below.
    groundedModel: 'groq/compound',
    prefer: [/^openai\/gpt-oss-120b$/, /gpt-oss-120b/, /^qwen/, /70b/, /gpt-oss/],
    fallback: 'openai/gpt-oss-120b',
  },
  mistral: {
    base: 'https://api.mistral.ai/v1', key: MISTRAL_KEY, label: 'Mistral',
    // A DATED large before a "-latest" large: an alias silently becomes the newest
    // model, and on a free tier the newest is exactly the one whose rate limit hasn't
    // been raised yet. Same for medium. (2026-09: large 250k TPM, medium-latest 20k.)
    prefer: [/^mistral-large-\d/, /^mistral-large/, /^mistral-medium-\d/, /^mistral-medium/,
             /^ministral-14b/, /^mistral-small/, /^ministral-8b/],
    fallback: 'mistral-large-2512',
  },
  cerebras: {
    base: 'https://api.cerebras.ai/v1', key: CEREBRAS_KEY, label: 'Cerebras',
    prefer: [/^gpt-oss-120b$/, /gpt-oss-120b/, /qwen.*235b/, /^qwen/, /^zai-glm/, /70b/],
    fallback: 'gpt-oss-120b',
  },
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini isn't OpenAI-compatible, but it has a catalogue too, so it joins the same
// discovery machinery. Flash models first: they carry the generous free-tier limits and
// the speed a live transcript needs, and Pro would burn the quota for no benefit here.
const GEMINI_CFG = {
  key: GEMINI_KEY, label: 'Gemini',
  prefer: [/^gemini-[\d.]+-flash$/, /flash-latest$/, /-flash$/, /flash/, /^gemini-[\d.]+-pro$/, /^gemma/],
  fallback: 'gemini-2.5-flash',
  list: listGeminiModels,
};

// Every provider whose model is discovered rather than pinned.
const MODEL_PROVIDERS = { ...OPENAI_COMPAT, gemini: GEMINI_CFG };

// Ids that are not general-purpose chat models: embeddings, moderation, speech, OCR,
// code-only and experimental families. They show up in the same listing.
const NON_CHAT_MODEL = /(embed|moderation|guard|whisper|tts|transcribe|voxtral|ocr|rerank|codestral|devstral|labs-|imagen|veo|aqa|native-audio|live-|-image|image-)/i;

const MODEL_TTL_MS = 6 * 60 * 60 * 1000; // re-read the catalogue twice a day
const MODEL_ATTEMPTS = 3;                // models to try per request before giving up
const MODEL_COOLDOWN_MS = 5 * 60 * 1000; // how long a model that just failed is skipped

// Reasoning models think before answering and that thinking is charged to the SAME token
// budget, without ever appearing in `content`. Groq documents gpt-oss returning an empty
// content when max_tokens is under ~1000 — and an empty answer is exactly what the client
// reads as "this provider failed". The families every provider now serves reason by
// default, so small calls (the ⭐ manual key point asks for 512) need a floor.
const REASONING_MODEL = /(gpt-oss|qwen|glm|deepseek|magistral|thinking|reason)/i;
const REASONING_MIN_TOKENS = 1200;

const modelCache = {};   // provider -> { ranked: [id], at }
const modelCooldown = {}; // "provider:model" -> timestamp it becomes usable again

// Google's catalogue: a different shape, and it states per model which methods it
// supports — the authoritative way to keep embedding/image/audio models out.
async function listGeminiModels(cfg) {
  const res = await fetch(GEMINI_BASE + '/models?pageSize=200&key=' + encodeURIComponent(cfg.key));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  const items = Array.isArray(raw?.models) ? raw.models : [];
  return items
    .filter(m => Array.isArray(m?.supportedGenerationMethods)
      && m.supportedGenerationMethods.includes('generateContent'))
    .map(m => String(m?.name || '').replace(/^models\//, ''))
    .filter(id => id && !NON_CHAT_MODEL.test(id));
}

async function listChatModels(cfg) {
  if (cfg.list) return cfg.list(cfg);
  const res = await fetch(cfg.base + '/models', {
    headers: { 'Authorization': 'Bearer ' + cfg.key },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  const items = Array.isArray(raw?.data) ? raw.data : [];
  return items
    .filter(m => {
      if (!m || typeof m.id !== 'string' || NON_CHAT_MODEL.test(m.id)) return false;
      // Mistral reports per-model capabilities; honour them when the field exists.
      if (m.capabilities && m.capabilities.completion_chat === false) return false;
      return true;
    })
    .map(m => m.id);
}

// Version numbers inside a model id, as numbers: "gemini-2.5-flash" → [2, 5],
// "mistral-large-2512" → [2512]. Used to tell generations apart within one family.
function versionOf(id) {
  return (id.match(/\d+/g) || []).map(Number);
}

// Newer first. Plain string ordering would put gemini-1.5-flash ahead of gemini-2.5-flash
// and an old dated snapshot ahead of a recent one — i.e. reliably choose the model
// closest to being retired.
function byNewest(a, b) {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

// Best first. Anything the preference list doesn't recognise still makes the list, last —
// an unknown model is worth trying before failing the request outright.
function rankModels(cfg, ids) {
  const rank = id => {
    const i = cfg.prefer.findIndex(re => re.test(id));
    return i === -1 ? cfg.prefer.length : i;
  };
  return ids.slice().sort((a, b) => rank(a) - rank(b) || byNewest(a, b));
}

async function rankedModels(provider) {
  const override = MODEL_OVERRIDES[provider];
  if (override) return [override]; // pinned on purpose — never look it up, never fall back

  const cached = modelCache[provider];
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.ranked;

  const cfg = MODEL_PROVIDERS[provider];
  try {
    const ranked = rankModels(cfg, await listChatModels(cfg));
    if (!ranked.length) throw new Error('no chat models listed');
    modelCache[provider] = { ranked, at: Date.now() };
    console.log(`[models] ${provider} → ${ranked.slice(0, MODEL_ATTEMPTS).join(' → ')} (${ranked.length} available)`);
    return ranked;
  } catch (err) {
    // The listing is a convenience, never a hard dependency: if it is down we still
    // answer, with the last known good ranking or the built-in default.
    const ranked = cached?.ranked || [cfg.fallback];
    console.warn(`[models] ${provider} listing failed (${err.message}) — using ${ranked[0]}`);
    return ranked;
  }
}

// The models to try for one request: best first, skipping any that failed recently.
function candidateModels(provider, ranked) {
  const now = Date.now();
  const fresh = ranked.filter(id => !(modelCooldown[provider + ':' + id] > now));
  // Everything is cooling down — which is what a provider that is down account-wide looks
  // like (Cerebras answers 402 for every model once billing lapses). Still give it a
  // chance rather than refusing outright, but only ONE: walking the full list would cost
  // three round trips on every single call, in the middle of a live press conference.
  if (!fresh.length) return ranked.slice(0, 1);
  return fresh.slice(0, MODEL_ATTEMPTS);
}

// A retired model id. Providers word it differently, so match the shape, not the text.
function isModelGone(status, message) {
  if (status === 404) return true;
  return /model.*(does not exist|not exist|not found|no longer|decommissioned|deprecated|unavailable)/i
    .test(message || '');
}

// Is another MODEL of the same provider worth a try? Yes when the problem is this model
// (retired, rate-limited, too small for the request, upstream hiccup). No when it is the
// account or the request itself — a bad key or a malformed body fails identically on all.
//
// 402/403 belong in the first group, not the second: providers gate individual models
// behind a paid plan while leaving others open, so "payment required to access this
// resource" is about the resource. Cerebras answers exactly that for its Production
// gpt-oss-120b on an account whose qwen quota is wide open.
function worthAnotherModel(status, message) {
  if (isModelGone(status, message)) return true;
  if (status === 429 || status === 413 || status === 402 || status === 403) return true;
  return status >= 500;
}

// Run one request against a provider, walking its ranked models until one answers.
// `attempt(model)` does the provider-specific call and returns
// { ok, status, message, text, result } — `result` is the finished response envelope.
// Everything about WHICH model to use, when to move on and what to park lives here, so
// every provider gets the same behaviour regardless of the dialect it speaks.
async function withModelFallback(provider, label, attempt) {
  let ranked = await rankedModels(provider);
  let queue = candidateModels(provider, ranked);
  const tried = new Set();
  let last = { status: 502, data: { error: { message: label + ': no model to try' } } };
  let relisted = false;

  while (queue.length) {
    const model = queue.shift();
    if (tried.has(model)) continue;
    tried.add(model);

    const { ok, status, message, text, result } = await attempt(model);
    if (ok && text) {
      delete modelCooldown[provider + ':' + model];
      return result;
    }

    // A 200 with no content is a failure of THIS model, not of the request: a reasoning
    // model can spend the whole budget thinking and answer nothing. The client would
    // read it as a dead provider, so fall through to the next model here instead.
    if (ok) {
      last = { status: 502, data: { error: { message: `${label}: "${model}" returned no content` } } };
      modelCooldown[provider + ':' + model] = Date.now() + MODEL_COOLDOWN_MS;
      console.warn(`[models] ${provider}: "${model}" returned empty content — next model`);
      continue;
    }

    last = { status, data: { error: { message: message || (label + ' API error') } } };
    if (!worthAnotherModel(status, message)) break;

    // This model is the problem, not the account — stop picking it for a few minutes so
    // the next calls don't pay for the same failure again.
    modelCooldown[provider + ':' + model] = Date.now() + MODEL_COOLDOWN_MS;
    console.warn(`[models] ${provider}: "${model}" failed (${status}: ${message}) — next model`);

    // A retirement means our cached catalogue is stale, so the rest of the queue may be
    // stale too. Re-read it once and carry on with what it now offers.
    if (isModelGone(status, message) && !relisted && !MODEL_OVERRIDES[provider]) {
      relisted = true;
      delete modelCache[provider];
      ranked = await rankedModels(provider);
      queue = candidateModels(provider, ranked).filter(id => !tried.has(id));
    }
  }

  return last;
}

// Generic handler for OpenAI-compatible chat APIs (Groq, Mistral, Cerebras all speak
// the same /chat/completions dialect).
async function handleOpenAICompat(provider, body) {
  const cfg = MODEL_PROVIDERS[provider];
  const { max_tokens, temperature, system, messages, grounded, json } = body;

  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const baseBody = {
    messages: msgs,
    temperature: temperature ?? 0,
    max_tokens: Math.min(max_tokens || 768, 4096),
  };

  const call = (b) => fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify(b),
  });

  // One model, including the JSON-mode retry. Returns the raw response + parsed body.
  async function tryModel(model) {
    const reqBody = { ...baseBody, model };
    if (REASONING_MODEL.test(model)) {
      reqBody.max_tokens = Math.max(reqBody.max_tokens, REASONING_MIN_TOKENS);
    }
    // Force valid JSON for structured calls (key points). Never with a search model.
    if (json && !grounded) reqBody.response_format = { type: 'json_object' };

    let response = await call(reqBody);
    let raw = await response.json().catch(() => ({}));
    let message = raw?.error?.message || raw?.message || '';
    // JSON mode can fail ("Failed to generate JSON"); retry once as plain text — the
    // prompt still asks for JSON and the client parses leniently. Only when the error is
    // actually about JSON: retrying a rate limit or a retired model here would just
    // double every call on the way down the fallback list.
    if (!response.ok && reqBody.response_format && /json|response_format|schema/i.test(message)) {
      delete reqBody.response_format;
      response = await call(reqBody);
      raw = await response.json().catch(() => ({}));
      message = raw?.error?.message || raw?.message || '';
    }
    return { response, raw, message };
  }

  function success(model, raw) {
    const msg = raw.choices?.[0]?.message || {};
    // Groq compound models report what they searched; pull source URLs when present.
    const sources = [];
    for (const t of (msg.executed_tools || [])) {
      const results = t?.search_results?.results || t?.results || [];
      for (const r of results) { if (r && r.url) sources.push(r.url); }
    }
    return {
      status: 200,
      data: { content: [{ type: 'text', text: msg.content || '' }], model, stop_reason: 'end_turn', sources },
    };
  }

  // Grounded search runs on one fixed model; there is nothing to fall back to.
  if (grounded && cfg.groundedModel) {
    const { response, raw, message } = await tryModel(cfg.groundedModel);
    if (!response.ok) return { status: response.status, data: { error: { message: message || (cfg.label + ' API error') } } };
    return success(cfg.groundedModel, raw);
  }

  return withModelFallback(provider, cfg.label, async (model) => {
    const { response, raw, message } = await tryModel(model);
    const text = response.ok ? (raw.choices?.[0]?.message?.content || '').trim() : '';
    return { ok: response.ok, status: response.status, message, text, result: success(model, raw) };
  });
}

// NOTE: Groq's web search does NOT work on the FREE tier. When a compound model
// actually searches, it injects page content into the request and exceeds the
// free-tier per-request token limit → 413 request_too_large. So grounded verification
// is currently DISABLED client-side; groundedModel is only reachable on a paid tier.
function handleGroq(body) {
  return handleOpenAICompat('groq', body);
}

// Mistral "La Plateforme", free "Experiment" tier.
function handleMistral(body) {
  return handleOpenAICompat('mistral', body);
}

// Cerebras inference — free tier with very high token limits, a good fallback for when
// Mistral runs out of tokens per minute mid-event.
function handleCerebras(body) {
  return handleOpenAICompat('cerebras', body);
}

app.post('/', async (req, res) => {
  const { messages, provider } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'Missing or invalid messages array' } });
  }

  try {
    let result;
    if (provider === 'groq' && GROQ_KEY) {
      result = await handleGroq(req.body);
    } else if (provider === 'mistral' && MISTRAL_KEY) {
      result = await handleMistral(req.body);
    } else if (provider === 'cerebras' && CEREBRAS_KEY) {
      result = await handleCerebras(req.body);
    } else if (provider === 'gemini' && GEMINI_KEY) {
      result = await handleGemini(req.body);
    } else if (provider === 'claude' && ANTHROPIC_KEY) {
      result = await handleClaude(req.body);
    } else if (provider) {
      // A specific provider was asked for but its key isn't configured here. Return a
      // clear error so the client's fallback chain can move to the next provider.
      result = { status: 400, data: { error: { message: `Provider "${provider}" not available on this proxy (missing API key)` } } };
    } else if (GROQ_KEY) {
      result = await handleGroq(req.body);
    } else if (GEMINI_KEY) {
      result = await handleGemini(req.body);
    } else {
      result = await handleClaude(req.body);
    }

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: { message: 'Proxy failed to reach API' } });
  }
});

// Gladia: start a live session server-side so the Gladia key never reaches the
// browser. The client sends the session config; we add the key and forward.
// Gladia returns a pre-authorized WebSocket URL the browser connects to directly.
app.post('/gladia/live', async (req, res) => {
  if (!GLADIA_KEY) {
    return res.status(400).json({ error: { message: 'GLADIA_API_KEY not configured on the proxy' } });
  }
  try {
    const response = await fetch('https://api.gladia.io/v2/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gladia-key': GLADIA_KEY,
      },
      body: JSON.stringify(req.body || {}),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Gladia proxy error:', err.message);
    res.status(502).json({ error: { message: 'Proxy failed to reach Gladia' } });
  }
});

// Open (no token) so the resolved models can be checked from a browser: this is what
// says which model each provider is actually using, and whether it was discovered or
// pinned with an env var.
app.get('/health', async (req, res) => {
  const providers = [];
  const models = {};
  const now = Date.now();
  for (const provider of Object.keys(MODEL_PROVIDERS)) {
    if (!MODEL_PROVIDERS[provider].key) continue;
    providers.push(provider);
    const ranked = await rankedModels(provider);
    const queue = candidateModels(provider, ranked);
    models[provider] = {
      using: queue[0],
      then: queue.slice(1),
      source: MODEL_OVERRIDES[provider] ? 'env' : 'auto',
      // Models parked after a recent failure, with the seconds left on each.
      cooling: ranked
        .filter(id => modelCooldown[provider + ':' + id] > now)
        .map(id => `${id} (${Math.round((modelCooldown[provider + ':' + id] - now) / 1000)}s)`),
    };
  }
  if (ANTHROPIC_KEY) providers.push('claude');
  res.json({ status: 'ok', providers, models, gladia: !!GLADIA_KEY });
});

app.listen(PORT, () => {
  console.log(`NewsPal proxy running on port ${PORT}`);
  // Warm the model rankings so the first real call doesn't pay for the listing, and so
  // the deploy logs record what each provider resolved to. Never blocks startup.
  for (const provider of Object.keys(MODEL_PROVIDERS)) {
    if (MODEL_PROVIDERS[provider].key) rankedModels(provider).catch(() => {});
  }
});
