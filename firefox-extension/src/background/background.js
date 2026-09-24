// background.js — Firefox adaptation
// Uses browser.* APIs (Firefox MV2 with promises)
// No tabCapture, no offscreen — audio capture handled in content script

let ANTHROPIC_KEY = '';
let PROXY_URL = '';
let PROXY_TOKEN = '';
let AI_PROVIDER = 'claude';
// Ordered fallback chain of LLM providers (proxy mode). callClaude tries them in order;
// if one errors or is out of quota, it moves to the next — like the translator's
// Google→Groq chain. Configured in the popup (storage `aiProviderChain`).
// Mistral leads by preference (European provider); the rest are the safety net.
const DEFAULT_PROVIDER_CHAIN = ['mistral', 'cerebras', 'groq'];
let AI_PROVIDERS = DEFAULT_PROVIDER_CHAIN.slice();
// The provider that served the most recent successful LLM call. When it flips (a fallback
// kicked in, or quota recovered) we notify the overlay so the user knows which model is
// live — and tag key points with it for the export (basic audit trail).
let activeProvider = '';
let SOURCE_LANGUAGE = 'auto';
let PARTICIPANTS = '';
const SERPER_KEY = '';

// User feedback (soft learning): examples injected into the key-point prompt.
let NEG_EXAMPLES = []; // "not relevant" — avoid extracting things like these
let POS_EXAMPLES = []; // "interesting" — prioritise things like these

// User feedback (hard learning): imperative rules distilled from the examples by the
// LLM every few feedback events. Injected into the key-point prompt as strict rules,
// user-editable in the popup ("Reglas aprendidas").
let LEARNED_RULES = [];
let FEEDBACK_SINCE_DISTILL = 0;
const DISTILL_EVERY = 5; // distil after this many new feedback examples

// Bilingual edition: `uiLanguage` (via lang.js setUiLang) drives the language the AI
// writes in; UNDERSTOOD_LANGS are the source languages that skip translation.
let UNDERSTOOD_LANGS = defaultUnderstoodLanguages();

async function loadKeys() {
  const data = await browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'aiProvider', 'aiProviderChain', 'sourceLanguage', 'participants', 'feedbackNegative', 'feedbackPositive', 'feedbackRules', 'feedbackSinceDistill', 'uiLanguage', 'understoodLanguages']);
  ANTHROPIC_KEY = data.anthropicKey || '';
  PROXY_URL = data.proxyUrl || '';
  PROXY_TOKEN = data.proxyToken || '';
  AI_PROVIDER = data.aiProvider || DEFAULT_PROVIDER_CHAIN[0];
  AI_PROVIDERS = (Array.isArray(data.aiProviderChain) && data.aiProviderChain.length)
    ? data.aiProviderChain
    : (data.aiProvider ? [data.aiProvider] : DEFAULT_PROVIDER_CHAIN.slice());
  SOURCE_LANGUAGE = data.sourceLanguage || 'auto';
  PARTICIPANTS = data.participants || '';
  NEG_EXAMPLES = Array.isArray(data.feedbackNegative) ? data.feedbackNegative : [];
  POS_EXAMPLES = Array.isArray(data.feedbackPositive) ? data.feedbackPositive : [];
  LEARNED_RULES = Array.isArray(data.feedbackRules) ? data.feedbackRules : [];
  FEEDBACK_SINCE_DISTILL = Number.isInteger(data.feedbackSinceDistill) ? data.feedbackSinceDistill : 0;
  setUiLang(data.uiLanguage || defaultUiLanguage());
  UNDERSTOOD_LANGS = (Array.isArray(data.understoodLanguages) && data.understoodLanguages.length)
    ? data.understoodLanguages
    : defaultUnderstoodLanguages();
}

// Keep the learning/prompt state in sync when it changes outside this script —
// the user editing rules in the popup, or restoring a backup, possibly mid-session
// (loadKeys only runs on start). Our own writes also land here; reassigning the
// same values is harmless.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.feedbackRules) {
    LEARNED_RULES = Array.isArray(changes.feedbackRules.newValue) ? changes.feedbackRules.newValue : [];
  }
  if (changes.feedbackNegative) {
    NEG_EXAMPLES = Array.isArray(changes.feedbackNegative.newValue) ? changes.feedbackNegative.newValue : [];
  }
  if (changes.feedbackPositive) {
    POS_EXAMPLES = Array.isArray(changes.feedbackPositive.newValue) ? changes.feedbackPositive.newValue : [];
  }
  if (changes.participants && typeof changes.participants.newValue === 'string') {
    PARTICIPANTS = changes.participants.newValue;
  }
  if (changes.aiProviderChain) {
    AI_PROVIDERS = (Array.isArray(changes.aiProviderChain.newValue) && changes.aiProviderChain.newValue.length)
      ? changes.aiProviderChain.newValue
      : DEFAULT_PROVIDER_CHAIN.slice();
  }
  if (changes.aiProvider && typeof changes.aiProvider.newValue === 'string') {
    AI_PROVIDER = changes.aiProvider.newValue;
  }
  if (changes.uiLanguage) {
    setUiLang(changes.uiLanguage.newValue || defaultUiLanguage());
    if (!(await browser.storage.local.get('understoodLanguages')).understoodLanguages) {
      UNDERSTOOD_LANGS = defaultUnderstoodLanguages();
    }
  }
  if (changes.understoodLanguages) {
    UNDERSTOOD_LANGS = (Array.isArray(changes.understoodLanguages.newValue) && changes.understoodLanguages.newValue.length)
      ? changes.understoodLanguages.newValue
      : defaultUnderstoodLanguages();
  }
});

// Store a feedback example (deduped, capped) and persist it across sessions.
// Every DISTILL_EVERY new examples, distil the accumulated feedback into rules.
function addFeedback(kind, text) {
  const t = (text || '').trim();
  if (!t) return;
  const arr = kind === 'neg' ? NEG_EXAMPLES : POS_EXAMPLES;
  if (arr.includes(t)) return;
  arr.push(t);
  while (arr.length > 15) arr.shift();
  FEEDBACK_SINCE_DISTILL++;
  const shouldDistill = FEEDBACK_SINCE_DISTILL >= DISTILL_EVERY;
  if (shouldDistill) FEEDBACK_SINCE_DISTILL = 0;
  browser.storage.local.set({ feedbackNegative: NEG_EXAMPLES, feedbackPositive: POS_EXAMPLES, feedbackSinceDistill: FEEDBACK_SINCE_DISTILL });
  if (shouldDistill) distillRules();
}

// Distil the 👎/⭐ examples into a short list of imperative rules (in Spanish, so the
// user can read/edit them in the popup). Silent: a failed distillation just leaves the
// previous rules in place.
let distillInFlight = false;

async function distillRules() {
  if (distillInFlight) return;
  if (NEG_EXAMPLES.length + POS_EXAMPLES.length < 3) return;
  distillInFlight = true;
  try {
    const input = [
      NEG_EXAMPLES.length ? `Marked NOT relevant by the user (discarded):\n- ${NEG_EXAMPLES.join('\n- ')}` : '',
      POS_EXAMPLES.length ? `Marked IMPORTANT by the user:\n- ${POS_EXAMPLES.join('\n- ')}` : '',
      LEARNED_RULES.length ? `Current rules:\n- ${LEARNED_RULES.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n');
    const raw = (await callClaude(input, distillPrompt(), false, 1024, true, true)).text;
    const obj = parseObject(raw);
    if (obj && Array.isArray(obj.rules)) {
      const rules = obj.rules
        .map(r => String(r).trim())
        .filter(r => r && r.length <= 200)
        .slice(0, 8);
      if (rules.length) {
        LEARNED_RULES = rules;
        browser.storage.local.set({ feedbackRules: LEARNED_RULES });
        console.log('[rules] distilled', rules.length, 'rules from feedback');
      }
    }
  } catch (err) {
    console.error('[rules] distill error:', err);
  } finally {
    distillInFlight = false;
  }
}

const EVALUATE_PROMPT = `You are a real-time fact-checker. Given a transcript excerpt, identify check-worthy factual claims and evaluate each one.

For each claim, return a JSON array of objects with these fields:
- "claim": the exact factual claim
- "verdict": one of TRUE, SUBSTANTIALLY TRUE, FALSE, MISLEADING, UNVERIFIABLE
- "confidence": one of HIGH, MEDIUM, LOW
- "explanation": 1-2 sentence explanation
- "speaker": who made the claim (use real names, never "Speaker N")
- "speaker_confidence": one of HIGH, MEDIUM, LOW (how committed the speaker sounds)

Only include check-worthy factual claims (statistics, historical events, policy claims, public records). Skip opinions, predictions, rhetorical questions, and value judgments.

Return ONLY a JSON array. No markdown, no explanation outside the array.`;

// Bilingual edition: the prompts are built on demand so the output language (and the
// category codes) follow the `uiLanguage` setting. promptLang() comes from lang.js.

function keypointsPrompt() {
  const L = promptLang();
  return `You are following a live press conference or political statement. From the transcript excerpt, extract the noteworthy KEY POINTS: announcements, figures/statistics, commitments or promises, factual claims, geopolitical and foreign-policy positions, statements about conflicts or security, accusations, threats, denials, named decisions, and important verbatim quotes.

Be EXTREMELY SELECTIVE — extract only what a journalist would put in a headline or jot down to quote later: a real announcement, a hard figure/statistic, a concrete commitment or promise, a named decision, or a significant claim (including geopolitical ones like "Iran will not have a nuclear weapon"). SKIP routine narration, scene-setting, transitions, hedging, thanks and small talk. ALSO skip personal praise, compliments and mutual flattery between officials (e.g. one leader calling another "a great guy / the best Secretary General"), greetings, and procedural remarks ("any questions?").

Return AT MOST ONE key point for this excerpt — the single most newsworthy item — and return NONE unless it clearly clears that bar. The DEFAULT answer is none: most excerpts produce {"points": []}. When in doubt, omit. Do NOT turn every sentence into a key point; restating the same idea in different words is NOT a new key point.

Do NOT judge whether anything is true — just capture what was said, neutrally.

CRITICAL — NO FABRICATION: Use ONLY the transcript excerpt provided in this request. Do NOT use any prior knowledge about the speaker or the event, and do NOT reproduce anything from the examples or the "already noted" list as if it were said now. The "quote" MUST be copied WORD FOR WORD from THIS excerpt. If a noteworthy statement is not literally present in this excerpt, return {"points": []}. Never invent, complete or recall a statement from memory.

MIND THE TEMPORAL CONTEXT: speakers often QUOTE HISTORY or recall past events (old wars, former possessions, past decisions). NEVER present a historical reference or rhetorical retelling as a current announcement, plan, position or threat. If a noteworthy point is historical, make that explicit in the wording (e.g. "recalls that…"); if you cannot tell whether it is current or historical, SKIP it rather than guess. KEEP THE SPEAKER'S OWN TENSE: something they describe as already done stays done — never turn it into a plan or an upcoming event. The request gives you the date this is being said; use it, never your own sense of when "now" is.

INTERPRETED EVENTS: many of these events have consecutive interpretation, so the SAME statement arrives twice — first in the speaker's own language, then interpreted into another one. Extract it ONCE, from the speaker's own words. If this excerpt is the interpreted repetition of something in the "already noted" list, even though it is in a different language, return {"points": []}.

Return ONLY a JSON object of the form {"points": [ ... ]} (no markdown, no text outside the JSON). Each element of "points" has:
- "point": a concise, neutral one-sentence summary, written in ${L.name.toUpperCase()}
- "category": a short UPPERCASE label. Prefer one of: ${L.cats}. If none fits well, invent a concise label in ${L.name} (one or two words, e.g. ${L.catExamples}). Use ${L.catOther} only as a last resort.
- "quote": the most relevant short verbatim fragment from the transcript, in its ORIGINAL language (or "" if none)
- "speaker": who said it, using a real name when known; never "Speaker N"; null if unknown

If nothing is noteworthy, return {"points": []}.`;
}

// What a translation must carry over untouched. A small model "localises" otherwise: it
// swapped a politician's name for another, and turned "en français" into "in Spanish".
const TRANSLATE_KEEP = 'Plain text only: no Markdown (no ** or #) and no original-script words added in parentheses. Keep every name, number, title, language, country and place as the text says — a name written in a non-Latin script goes in its usual Latin-script form — translate the words, never replace one of these with a different one.';

// Small models format anyway (a Mandarin session got **bold** names in the AI translations
// and *italics* in the summary), so the output is cleaned in code, not just asked for.
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/^#{1,6}\s+/gm, '');
}

function translatePrompt(sourceCode) {
  const L = promptLang();
  // Source known (Gladia tags each utterance): name it, and drop the passthrough clause.
  // "If it is already in Spanish or English, return it as-is" is what made a small model
  // echo French and Finnish lines untouched, and once translate French into English.
  if (sourceCode) {
    const src = languageDisplayName(sourceCode, 'en');
    return `Translate the user's ${src} text into ${L.name}. Output ONLY the ${L.name} translation — no quotes, no notes, no explanation. ${TRANSLATE_KEEP}`;
  }
  const passthrough = [...new Set([L.name, ...UNDERSTOOD_LANGS.map(langName).filter(Boolean)])];
  const passList = passthrough.length > 1
    ? passthrough.slice(0, -1).join(', ') + ' or ' + passthrough[passthrough.length - 1]
    : passthrough[0];
  return `Translate the user's text into ${L.name}. If the text is already in ${passList}, return it EXACTLY as-is, unchanged. Output ONLY the resulting text — no quotes, no notes, no explanation. ${TRANSLATE_KEEP}`;
}

function verifyPrompt() {
  const L = promptLang();
  return `You are a fact-checker. Evaluate the SINGLE claim the user provides, using the web results if given and your own knowledge. Take the event date/context into account.

Return ONLY a JSON object (no array, no markdown) with:
- "verdict": one of TRUE, SUBSTANTIALLY TRUE, FALSE, MISLEADING, UNVERIFIABLE
- "confidence": one of HIGH, MEDIUM, LOW
- "explanation": 1-2 sentences IN ${L.name.toUpperCase()} explaining the verdict and what the evidence says

No text outside the JSON object.`;
}

function summaryPrompt() {
  const L = promptLang();
  return `You are summarizing a live press conference for a professional who reads ${L.name}. The user gives you the key points (if any) and usually the transcript of what was said, in its original language. Write a TRUE NARRATIVE SUMMARY in ${L.name.toUpperCase()}, in PLAIN TEXT (no Markdown symbols like # or *).

CRITICAL: the key points are ALREADY listed separately in the report, so do NOT repeat them. This must be a SYNTHESIS in flowing prose — NOT a list. Absolutely NO bullet points, NO "• ", NO enumerating the points one by one. Instead, weave what was said into connected paragraphs that explain what the event was about, who said what, the main lines of argument, the most significant decisions/figures/positions, and the overall takeaway. Group related points, drop repetition, and connect ideas with prose.

COVER THE WHOLE EVENT: the key points may cover only part of it — use the transcript to include every topic that was discussed, not just the ones with a key point.

LENGTH FOLLOWS THE INPUT: one short paragraph for a short or thin input, up to four for a long event. Never pad: do NOT add background, history, motives or analysis that is not in the input — if little was said, write little.

The transcript comes from automatic speech recognition and may contain misheard words or a phrase that doesn't belong. If a word makes no sense in context, leave it out rather than build on it or guess what was meant.

You may also get a MACHINE TRANSLATION of the transcript. It is only a reading aid and can be wrong. Use it to understand the original and to read a name that speech recognition garbled. DATES, NUMBERS and FIGURES come only from the original transcript: never take a month, year or figure that appears only in the translation. When the two disagree on anything else, prefer the original.

Think of it as the opening paragraphs a journalist writes ABOVE the bullet list of facts: it should add understanding by connecting what was said, not duplicate the list.

ONLY if the input explicitly marks points as "[${L.verifiedMarker}: ...]", you may add at the end a short "${L.verifHeading}" paragraph mentioning those verdicts in prose. NEVER invent or imply a fact-check, and never state that anything has been "confirmed"/"verified" unless it is marked as such in the input.

Mind the temporal context: if a point is a historical reference or a retelling of past events, present it as such — NEVER turn history into current events, plans or threats, and never infer intentions beyond what was literally said. The input gives the date and time the event is taking place: it is happening NOW, so keep every statement in the tense the transcript uses — what a speaker describes as already done must not become something still to come.

Roles: never add a status qualifier of your own (former, ex-, outgoing, interim, acting, -elect). Use the plain title unless the input itself says otherwise — your knowledge of who currently holds an office may simply be out of date.

Be concise and neutral. Report only what was said; do not assess truth yourself. You may give a person the role or title you know them by, even if it may be out of date, but never make one up when you don't actually know it. People's NAMES, however, come only from the input: use them as they appear there, and never add a person who isn't in it or put a different person in their place — the same goes for which country someone represents. Return only the summary text.`;
}

function distillPrompt() {
  const L = promptLang();
  return `You maintain a SHORT list of editorial rules for extracting key points from live press conferences. The rules are learned from user feedback: examples the user discarded as NOT relevant, examples the user marked as IMPORTANT, and the current rule list.

Produce an UPDATED list of AT MOST 8 rules, each ONE short imperative sentence IN ${L.name.toUpperCase()} (e.g. ${L.ruleExamples}).

- GENERALISE the pattern behind the examples; do not just restate a single example.
- Keep current rules that are still supported by the examples; merge near-duplicates; drop rules the examples now contradict.
- Only write a rule when the examples give clear evidence for it — fewer good rules beat many weak ones.
- Rules must be about WHAT to extract or skip (content criteria), never about formatting or truthfulness.

Return ONLY a JSON object of the form {"rules": ["...", "..."]} — no markdown, no text outside the JSON.`;
}

function manualKeypointPrompt() {
  const L = promptLang();
  return `The user manually marked this transcript fragment as important. Turn it into EXACTLY ONE key point. You may be given PRECEDING TRANSCRIPT and a list of participants: use them ONLY to tell who is speaking and to understand what the fragment refers to — summarize ONLY the marked fragment, NEVER the context. If the fragment is ONE statement, summarize it whole, from its first sentence to its last — do not drop the beginning or keep only the ending. If it contains SEVERAL distinct statements (the user selected a long passage), summarize the most newsworthy one instead of blending them all together. Return ONLY a JSON object: {"point": "<concise neutral one-sentence summary in ${L.name.toUpperCase()} covering the entire fragment>", "category": "<one of ${L.cats}, or a short ${L.name} label>", "quote": "<the FULL fragment in its original language>", "speaker": "<who said the fragment: follow the Participants rule given in the user message — use the EXACT participant name, or ${L.otherSpeaker} for anyone not listed, or null if truly impossible to tell>"}. No text outside the JSON.`;
}

// ── Speaker parsing ──────────────────────────────────────────────────────────

function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

// ── Serper ────────────────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = [
  'reddit.com', 'facebook.com', 'twitter.com', 'x.com',
  'tiktok.com', 'instagram.com', 'pinterest.com', 'quora.com',
  'yelp.com', 'tripadvisor.com', 'youtube.com',
  'democrats.org', 'republicans.org', 'gop.com', 'dnc.org',
  'breitbart.com', 'dailykos.com', 'mediamatters.org', 'newsmax.com',
  'thefederalist.com', 'motherjones.com', 'nationalreview.com',
];

async function searchWeb(query, retries = 2) {
  if (!SERPER_KEY) return [];
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_KEY },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    const data = await res.json();
    return (data.organic ?? [])
      .map(r => r.link)
      .filter(url => url && !BLOCKED_DOMAINS.some(d => url.includes(d)))
      .slice(0, 3);
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500 * (3 - retries)));
      return searchWeb(query, retries - 1);
    }
    console.error('[serper] error:', err);
    return [];
  }
}

// ── Claude (direct or proxy) ─────────────────────────────────────────────────

// Record which provider just served a call; announce a flip to the overlay.
function setActiveProvider(provider) {
  if (!provider || provider === activeProvider) return;
  const previous = activeProvider;
  activeProvider = provider;
  if (activeTabId) sendToTab(activeTabId, { type: 'MODEL_CHANGED', provider, previous });
}

// Key-point extraction and translation call the chain SILENTLY, because a single
// transient failure is normal and a red toast every window would be noise. But when the
// whole chain fails over and over (a retired model id, a dead proxy) that silence hides
// a session that will never produce a key point again — so an outage is announced once,
// and so is the recovery.
const CHAIN_OUTAGE_AFTER = 3; // consecutive all-providers-failed calls
let chainFailureStreak = 0;
let chainOutageReported = false;

function noteChainSuccess() {
  chainFailureStreak = 0;
  if (chainOutageReported) {
    chainOutageReported = false;
    if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_INFO', message: t('bg_llm_recovered') });
  }
}

// Returns true when this failure should be shown even to a silent caller.
function noteChainFailure() {
  chainFailureStreak++;
  if (chainOutageReported || chainFailureStreak < CHAIN_OUTAGE_AFTER) return false;
  chainOutageReported = true;
  return true;
}

// Parse a proxy response body into our {text, sources} shape (empty text = failure).
function parseLLMResponse(data) {
  const raw = data?.content?.[0]?.text?.trim() || '';
  const text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // The proxy reports which model of the provider actually answered. "vía Mistral" alone
  // hid whether a call went to mistral-large or fell through to a smaller model.
  return {
    text,
    sources: Array.isArray(data?.sources) ? data.sources : [],
    model: typeof data?.model === 'string' ? data.model : '',
  };
}

async function callClaude(userMessage, systemPrompt, grounded = false, maxTokens = 768, json = false, silent = false) {
  // Direct Anthropic key path (no proxy) stays single-provider.
  if (!PROXY_URL) {
    if (!ANTHROPIC_KEY) {
      if (!silent && activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: t('bg_llm_no_key') });
      return { text: '', sources: [] };
    }
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      const data = await res.json();
      if (data.error) {
        if (!silent && activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: fmt(t('bg_llm_api_error'), { detail: data.error.message || 'API error' }) });
        return { text: '', sources: [] };
      }
      setActiveProvider('claude');
      noteChainSuccess();
      return parseLLMResponse(data);
    } catch (err) {
      if (!silent && activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: fmt(t('bg_llm_api_error'), { detail: err.message }) });
      return { text: '', sources: [] };
    }
  }

  // Proxy mode: walk the provider fallback chain. On any error, empty response, or
  // network failure, move to the next provider (mirrors the translator's chain), so a
  // quota/rate limit on one model doesn't kill the session mid-event.
  const proxyHeaders = { 'Content-Type': 'application/json' };
  if (PROXY_TOKEN) proxyHeaders['x-proxy-token'] = PROXY_TOKEN;
  const chain = AI_PROVIDERS.length ? AI_PROVIDERS : DEFAULT_PROVIDER_CHAIN.slice();
  // One entry per provider that failed. Reporting only the LAST error made the toast
  // look like the last model in the chain was the only one tried (and hid, for example,
  // that a retired model id had killed every provider at once).
  const failures = [];

  for (const provider of chain) {
    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({
          provider,
          // model hints only matter for gemini/claude; the OpenAI-compatible providers
          // (groq/mistral/cerebras) pick their own model in the proxy.
          model: provider === 'gemini' ? 'gemini-2.0-flash'
               : provider === 'claude' ? 'claude-haiku-4-5-20251001' : undefined,
          max_tokens: maxTokens,
          temperature: 0,
          grounded,
          json,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const err = data.error?.message || ('HTTP ' + res.status);
        failures.push({ provider, err });
        console.warn(`[claude] provider "${provider}" failed: ${err} — trying next`);
        continue;
      }
      const parsed = parseLLMResponse(data);
      if (!parsed.text) {
        failures.push({ provider, err: 'empty response' });
        console.warn(`[claude] provider "${provider}" returned empty — trying next`);
        continue;
      }
      setActiveProvider(provider);
      noteChainSuccess();
      console.log(`[claude] ${provider} answered with model ${parsed.model || '?'}`);
      return parsed;
    } catch (err) {
      failures.push({ provider, err: err.message });
      console.warn(`[claude] provider "${provider}" threw: ${err.message} — trying next`);
    }
  }

  // Every provider in the chain failed. The detail stays in the provider's own words
  // (it names the model/quota that broke), but the sentence around it is translated.
  const detail = failures.map(f => `${providerLabel(f.provider)}: ${f.err}`).join(' · ');
  console.error('[claude] all providers failed:', detail);
  const outage = noteChainFailure();
  if ((!silent || outage) && activeTabId) {
    sendToTab(activeTabId, {
      type: 'PIPELINE_ERROR',
      message: detail ? fmt(t('bg_llm_all_failed'), { detail }) : t('bg_llm_none'),
    });
  }
  return { text: '', sources: [] };
}

function parseArray(str) {
  const start = str.indexOf('[');
  const end = str.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(str.slice(start, end + 1)); }
  catch { return []; }
}

function parseObject(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(str.slice(start, end + 1)); }
  catch { return null; }
}

// ── Lexical features ──────────────────────────────────────────────────────────

const HEDGING_WORDS = ['think','believe','maybe','perhaps','probably','might','could','seem','appears','guess','suppose','somewhat'];
const CERTAINTY_WORDS = ['definitely','certainly','absolutely','always','never','clearly','obviously','undoubtedly','exactly','proven'];
const FILLER_WORDS = ['um','uh','like','basically','actually','literally','right','okay'];
const EMOTIONAL_WORDS = ['disaster','terrible','horrible','amazing','incredible','great','awful','fantastic','disgusting','wonderful','worst','best'];
const EXCLUSIVE_WORDS = ['but','except','however','although','unless','without','exclude'];
const FP_SINGULAR = ['i','me','my','mine','myself'];

function extractLexical(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const rate = (list) => Math.round(words.filter(w => list.some(h => w.includes(h))).length / total * 100);
  return {
    rates: {
      hedging: rate(HEDGING_WORDS),
      certainty: rate(CERTAINTY_WORDS),
      filler: rate(FILLER_WORDS),
      emotional: rate(EMOTIONAL_WORDS),
      exclusive: rate(EXCLUSIVE_WORDS),
      firstPersonSg: Math.round(words.filter(w => FP_SINGULAR.includes(w)).length / total * 100),
    },
    wordsPerSecond: null,
    wordCount: total,
  };
}

function buildLexicalSummary(f) {
  const r = f.rates || f;
  const notes = [];
  if (r.hedging > 8) notes.push(`hedging language (${r.hedging}%)`);
  if (r.certainty > 8) notes.push(`certainty markers (${r.certainty}%)`);
  if (r.filler > 8) notes.push(`filler words (${r.filler}%)`);
  if (r.emotional > 8) notes.push(`emotional language (${r.emotional}%)`);
  if (r.exclusive > 8) notes.push(`qualifying words (${r.exclusive}%)`);
  if (r.firstPersonSg > 8) notes.push(`first-person singular (${r.firstPersonSg}%)`);
  if (f.wordsPerSecond) {
    const pace = f.wordsPerSecond > 3.5 ? 'fast' : f.wordsPerSecond < 2 ? 'slow' : 'moderate';
    notes.push(`speech rate ${f.wordsPerSecond} w/s (${pace})`);
  }
  return notes.length ? `Features detected: ${notes.join(', ')}.` : 'Neutral delivery.';
}

// ── Claim deduplication ───────────────────────────────────────────────────────

const recentClaims = new Map();
const CLAIM_DEDUP_MS = 200000;

function normalizeClaimKey(claim) {
  return claim.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .sort()
    .join(' ');
}

// Register a claim as seen without judging it. A ⭐ point is the user's own decision and is
// always kept, but it was never recorded, so the automatic extraction re-found the same
// statement a window later (with more context) and showed it twice.
function rememberClaim(claim) {
  if (claim && claim.trim()) recentClaims.set(normalizeClaimKey(claim), [Date.now(), claim]);
}

// The claim already on screen that `claim` repeats, or '' when it is new. Pure: nothing is
// recorded here, so the caller decides what to keep (a repeat can EXPAND the card it
// repeats instead of being dropped) and only that survivor is remembered.
function duplicateOf(claim) {
  const key = normalizeClaimKey(claim);
  const now = Date.now();

  for (const [k, v] of recentClaims) {
    const t = Array.isArray(v) ? v[0] : v;
    if (now - t > CLAIM_DEDUP_MS) recentClaims.delete(k);
  }

  const storedClaim = k => { const v = recentClaims.get(k); return (Array.isArray(v) ? v[1] : '') || ''; };
  if (recentClaims.has(key)) return storedClaim(key) || claim;

  const keyWords = new Set(key.split(' ').filter(Boolean));
  const figures = (claim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
    .map(d => d.replace(/[,\s]/g, '').toLowerCase());

  for (const [k, v] of recentClaims) {
    const origClaim = (Array.isArray(v) ? v[1] : '') || '';
    const kWords = k.split(' ').filter(Boolean);
    if (kWords.filter(w => keyWords.has(w)).length / Math.max(keyWords.size, kWords.length) >= 0.35) {
      return origClaim || claim;
    }
    if (figures.length && origClaim) {
      const origFigures = (origClaim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
        .map(d => d.replace(/[,\s]/g, '').toLowerCase());
      if (figures.some(f => origFigures.includes(f))) return origClaim;
    }
  }

  return '';
}

// Is the repeat worth showing in place of what is already on the card? Only when it says
// the same thing AND adds to it — the automatic pass sees a six-sentence window, so it
// often completes a ⭐ fragment the user marked. His call (2026-09-24): one card, the
// fuller wording, and he trims it with ✏️ if it went too far.
function isRicherClaim(candidate, existing) {
  const words = s => normalizeClaimKey(s).split(' ').filter(Boolean);
  const oldWords = words(existing), newWords = new Set(words(candidate));
  if (!oldWords.length) return false;
  const kept = oldWords.filter(w => newWords.has(w)).length / oldWords.length;
  return kept >= 0.6 && candidate.trim().length >= existing.trim().length * 1.2;
}

// ── Rolling window ────────────────────────────────────────────────────────────

const WINDOW_SIZE = 6;
const WINDOW_KEEP = 15;

let sentenceWindow = [];
let sentenceCount = 0;
let windowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
let windowStartTime = null;
let pageTitle = '';
let pageDate = '';
let sessionStartedAt = null; // when HE pressed Start — the date the prompts get
let currentSpeakerId = null;
let lastSpeakerId = null;
let speakerIdToName = {};
let confirmedSpeakers = new Set();

function resetWindow() {
  sentenceWindow = [];
  sentenceCount = 0;
  windowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
  windowStartTime = null;
  currentSpeakerId = null;
  lastSpeakerId = null;
  speakerIdToName = {};
  confirmedSpeakers = new Set();
}

function resetLexical() {
  return { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
}

async function onNewSentence(text, speakerId, timecode) {
  if (lastSpeakerId !== null &&
      speakerId !== null && speakerId !== undefined &&
      speakerId !== lastSpeakerId &&
      sentenceCount % WINDOW_SIZE !== 0 &&
      sentenceWindow.length >= 2) {
    const flushText = sentenceWindow.map(s => s.text).join(' ');
    const flushCounts = {};
    sentenceWindow.slice(-WINDOW_SIZE).forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined)
        flushCounts[s.speakerId] = (flushCounts[s.speakerId] || 0) + 1;
    });
    const flushDominantId = Object.keys(flushCounts).length
      ? Object.entries(flushCounts).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const flushDominantSpeaker = flushDominantId !== null ? (speakerIdToName[flushDominantId] || null) : null;
    const flushLexSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const flushLexSummary = buildLexicalSummary(flushLexSnapshot);
    windowLexical = resetLexical();
    windowStartTime = null;
    await extractKeyPoints(flushText, pageTitle, flushLexSummary, flushLexSnapshot, flushDominantSpeaker, flushDominantId, sentenceWindow.slice());
  }
  lastSpeakerId = speakerId;

  const confirmedName = (speakerId !== null && speakerId !== undefined) ? speakerIdToName[speakerId] : null;
  const label = confirmedName ? `[${confirmedName}]` : (speakerId !== null && speakerId !== undefined ? `[Speaker ${speakerId}]` : null);
  const labeledText = label ? `${label} ${text}` : text;

  sentenceWindow.push({ text: labeledText, speakerId, speakerName: confirmedName, timecode: timecode || getClockTimecode() });
  if (sentenceWindow.length > WINDOW_KEEP) sentenceWindow.shift();
  sentenceCount++;

  if (!windowStartTime) windowStartTime = Date.now();

  const f = extractLexical(text);
  const r = f.rates, wr = windowLexical.rates;
  wr.hedging = Math.round((wr.hedging + r.hedging) / 2);
  wr.certainty = Math.round((wr.certainty + r.certainty) / 2);
  wr.filler = Math.round((wr.filler + r.filler) / 2);
  wr.emotional = Math.round((wr.emotional + r.emotional) / 2);
  wr.exclusive = Math.round((wr.exclusive + r.exclusive) / 2);
  wr.firstPersonSg = Math.round((wr.firstPersonSg + r.firstPersonSg) / 2);
  windowLexical.wordCount += f.wordCount;

  if (sentenceCount % WINDOW_SIZE === 0) {
    const contextText = sentenceWindow.map(s => s.text).join(' ');
    const currentWindowSentences = sentenceWindow.slice(-WINDOW_SIZE);
    const counts = {};
    currentWindowSentences.forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined)
        counts[s.speakerId] = (counts[s.speakerId] || 0) + 1;
    });
    const dominantSpeakerId = Object.keys(counts).length
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const dominantSpeaker = dominantSpeakerId !== null
      ? (speakerIdToName[dominantSpeakerId] || null)
      : null;

    const elapsed = windowStartTime ? (Date.now() - windowStartTime) / 1000 : null;
    if (elapsed && elapsed > 0) windowLexical.wordsPerSecond = Math.round(windowLexical.wordCount / elapsed * 10) / 10;
    windowStartTime = null;

    const lexicalSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const lexicalSummary = buildLexicalSummary(lexicalSnapshot);
    windowLexical = resetLexical();
    windowStartTime = null;

    try {
      await extractKeyPoints(contextText, pageTitle, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId, sentenceWindow.slice());
    } catch (e) {
      console.error('[window] evaluation error:', e);
    }
  }
}

// ── Evaluation pipeline ───────────────────────────────────────────────────────

async function evaluateClaims(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateContext = pageDate ? `\nDate: ${pageDate}` : '';
    const titleNames = parseSpeakersFromTitle(title || '');
    const nameList = titleNames.join(' and ');
    const speakerLegend = titleNames.length
      ? `\nDebate participants: ${nameList}.` +
        `\nSpeaker attribution rules:` +
        `\n- Identify speakers using: (1) first-person language; (2) policy content; (3) cross-references.` +
        `\n- Use your knowledge of each participant's background and policies.` +
        `\n- NEVER output "Speaker N" in any field.`
      : `\nIdentify speakers using first-person language, policy content, and speech patterns. Never output "Speaker N".`;

    const titleContext = title
      ? `Video: "${title}"${dateContext}${speakerLegend}\n\nEvaluate claims as they were made at the time of this recording.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const checkedList = [...recentClaims.values()]
      .filter(v => Array.isArray(v) && v[1])
      .map(v => v[1])
      .slice(-15)
      .join('\n- ');
    const alreadyChecked = checkedList
      ? `\n\nClaims already fact-checked — do NOT re-evaluate:\n- ${checkedList}\n`
      : '';

    const raw = (await callClaude(
      `${titleContext}Transcript: "${contextText}"${alreadyChecked}${lexicalContext}`,
      EVALUATE_PROMPT
    )).text;
    const results = parseArray(raw);
    const valid = results.filter(r => {
      if (!r.claim || !r.verdict || duplicateOf(r.claim)) return false;
      rememberClaim(r.claim); // only what survives is remembered
      return true;
    });

    if (!valid.length) return;

    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'NEW_VERDICT',
        results: valid.map(r => ({
          ...r,
          sources: [],
          pending: true,
          lexical: lexicalSnapshot,
          dominantSpeakerId,
          speaker: dominantSpeaker || (r.speaker && !r.speaker.match(/^Speaker\s*\d+$/i) ? r.speaker : null),
        })),
      });
    }

    groundAndUpdate(contextText, valid, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);
  } catch (err) {
    console.error('[pipeline] error:', err);
  }
}

async function groundAndUpdate(contextText, fastResults, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateCtx = pageDate ? `\nDate: ${pageDate}` : '';
    const titleContext = title
      ? `Video: "${title}"${dateCtx}\nEvaluate claims as they were made at the time of this recording.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const groundedAll = await Promise.all(fastResults.map(async (fastResult) => {
      try {
        const urls = await searchWeb(fastResult.claim);
        if (!urls.length) return null;
        const raw = (await callClaude(
          `${titleContext}Transcript: "${contextText}"\n\nEvaluate ONLY this claim:\n1. ${fastResult.claim}\n\nWeb results:\n${urls.join('\n')}${lexicalContext}`,
          EVALUATE_PROMPT
        )).text;
        const results = parseArray(raw);
        const match = results.find(r => r.claim && r.verdict);
        if (!match) return null;

        const lateResolved = dominantSpeakerId !== null && dominantSpeakerId !== undefined
          ? speakerIdToName[dominantSpeakerId] || null : null;
        const resolvedSpeaker = lateResolved || dominantSpeaker
          || (match.speaker && !match.speaker.match(/^Speaker\s*\d+$/i) ? match.speaker : null)
          || (fastResult.speaker && !fastResult.speaker.match(/^Speaker\s*\d+$/i) ? fastResult.speaker : null);

        const fastWasTrue = fastResult.verdict === 'TRUE' || fastResult.verdict === 'SUBSTANTIALLY TRUE';
        const groundedIsMisleading = match.verdict === 'MISLEADING';
        const finalVerdict = (fastWasTrue && groundedIsMisleading) ? fastResult.verdict : match.verdict;

        return { ...match, verdict: finalVerdict, sources: urls, pending: false, lexical: lexicalSnapshot, speaker: resolvedSpeaker, dominantSpeakerId };
      } catch (err) {
        console.error('[grounded] error:', err);
        return null;
      }
    }));

    const valid = groundedAll.filter(Boolean);
    if (valid.length && activeTabId) {
      sendToTab(activeTabId, { type: 'UPDATE_VERDICTS', results: valid });
    }
  } catch (err) {
    console.error('[grounded] error:', err);
  }
}

// ── Key points (neutral, no verdict) ──────────────────────────────────────────

// The speaker-attribution legend used by BOTH the automatic key points and the manual
// ⭐ ones, so they stay in sync: Gladia gives us no speaker labels, so the model infers
// who is speaking, constrained to the user's Participants (or names parsed from the
// title). Anyone not listed → "Otro"; only null when truly impossible.
// "2026-09-24 16:22" — unambiguous for a model, unlike a locale-formatted date.
function clockDateTime(ms) {
  const d = new Date(ms || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildParticipantContext(title) {
  // The page almost never publishes a date, and without one the model dates the event by
  // its own (frozen) knowledge: it turned "last May, we created the Board of Trade" into a
  // plan for a visit still to come. The clock is the reliable source — we are watching live.
  const dateContext = `\nDate and time, happening live right now: ${pageDate || clockDateTime(sessionStartedAt)}`;
  const participantList = PARTICIPANTS
    ? PARTICIPANTS.split(',').map(s => s.trim()).filter(Boolean)
    : parseSpeakersFromTitle(title || '');
  const otherSpk = promptLang().otherSpeaker;
  const speakerLegend = participantList.length
    ? `\nParticipants: ${participantList.join(', ')}. For "speaker": if it is clearly one of these participants, use that EXACT name; if it is someone else (a journalist or moderator asking a question, or anyone not listed), use "${otherSpk}"; use null only if truly impossible to tell. Do NOT force a non-participant onto a participant's name.`
    : `\nIdentify the speaker from context; use "${otherSpk}" for journalists/moderators; use null if unclear; never output "Speaker N".`;
  const titleContext = (title || participantList.length)
    ? `Event: "${title || ''}"${dateContext}${speakerLegend}\n\n`
    : '';
  return { participantList, speakerLegend, titleContext };
}

// Anti-fabrication guard for a fact-check tool: a key point's quote must ACTUALLY be in
// the transcript window it was extracted from. Catches a model inventing a quote from
// prior knowledge or echoing an injected example (both would not appear in `context`).
// Tolerant of light reformatting (punctuation/casing/minor ASR edits) via word overlap.
function quoteInContext(quote, context) {
  const q = (quote || '').trim();
  if (!q) return false; // no quote to verify → can't vouch for it, so don't show it
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q), nc = norm(context);
  if (!nq || !nc) return false;
  if (nc.includes(nq)) return true;
  const qWords = nq.split(' ').filter(w => w.length >= 4);
  if (!qWords.length) return nc.includes(nq);
  const cWords = new Set(nc.split(' '));
  const hits = qWords.filter(w => cWords.has(w)).length;
  return (hits / qWords.length) >= 0.6;
}

// WHEN was the quote said (not when we extracted it): the timecode of the window
// sentence that contains it. Exact containment first (a multi-sentence quote gets the
// sentence where it starts); then the sentence best covered by the quote's words.
// Fallback = start of the newest extraction window — never "now": extraction runs
// several sentences after the statement, so the clock time is always misleading.
function findQuoteTimecode(quote, sentences) {
  const list = (sentences || []).filter(s => s && s.timecode);
  if (!list.length) return '';
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(quote || '');
  if (nq) {
    for (const s of list) { if (norm(s.text).includes(nq)) return s.timecode; }
    const qWords = new Set(nq.split(' ').filter(w => w.length >= 4));
    if (qWords.size) {
      let best = null, bestScore = 0;
      for (const s of list) {
        const sWords = norm(s.text).split(' ').filter(w => w.length >= 4);
        if (!sWords.length) continue;
        const hits = sWords.filter(w => qWords.has(w)).length;
        const score = hits / sWords.length;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (best && bestScore >= 0.5) return best.timecode;
    }
  }
  return list[Math.max(0, list.length - WINDOW_SIZE)].timecode;
}

async function extractKeyPoints(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId, windowSentences) {
  try {
    const { titleContext } = buildParticipantContext(title);

    const notedList = [...recentClaims.values()]
      .filter(v => Array.isArray(v) && v[1])
      .map(v => v[1])
      .slice(-15)
      .join('\n- ');
    const alreadyNoted = notedList ? `\n\nAlready noted — do NOT repeat:\n- ${notedList}\n` : '';

    let feedbackCtx = '';
    if (LEARNED_RULES.length) {
      feedbackCtx += `\n\nSTRICT USER RULES — always apply these when deciding what to extract or skip (they override the general guidance; they are written in Spanish):\n- ${LEARNED_RULES.join('\n- ')}`;
    }
    if (NEG_EXAMPLES.length) {
      feedbackCtx += `\n\nThe user marked these as NOT relevant — do NOT extract anything like them:\n- ${NEG_EXAMPLES.slice(-15).join('\n- ')}`;
    }
    if (POS_EXAMPLES.length) {
      feedbackCtx += `\n\nThe user marked these as important — prioritise anything similar:\n- ${POS_EXAMPLES.slice(-15).join('\n- ')}`;
    }

    const answer = await callClaude(
      `${titleContext}Transcript: "${contextText}"${alreadyNoted}${feedbackCtx}`,
      keypointsPrompt(),
      false, 2048, true, true
    );
    const raw = answer.text;
    const obj = parseObject(raw);
    const results = (obj && Array.isArray(obj.points)) ? obj.points : parseArray(raw);
    // Hard cap: keep at most the single most newsworthy point per excerpt, even if
    // the model returns several — the prompt asks for ≤1, this guards against drift.
    // quoteInContext first: reject fabricated/echoed quotes not in this window.
    const usable = results.filter(r => r.point && quoteInContext(r.quote, contextText));
    // A brand-new point wins; otherwise the best repeat, which may still expand its card.
    const candidate = usable.find(r => !duplicateOf(r.point)) || usable[0];
    if (!candidate) return;

    const repeats = duplicateOf(candidate.point);
    if (repeats) {
      // Same statement said (or interpreted) again. One card: keep the fuller wording.
      if (!isRicherClaim(candidate.point, repeats)) return;
      rememberClaim(candidate.point);
      if (activeTabId) {
        sendToTab(activeTabId, { type: 'EXPAND_KEYPOINT', previous: repeats, point: candidate.point });
      }
      return;
    }
    rememberClaim(candidate.point);
    const valid = [candidate];

    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'NEW_KEYPOINTS',
        results: valid.map(r => ({
          point: r.point,
          category: (r.category || promptLang().catOther).toUpperCase(),
          quote: r.quote || '',
          speaker: dominantSpeaker
            || (r.speaker && !String(r.speaker).match(/^Speaker\s*\d+$/i) ? r.speaker : null),
          dominantSpeakerId,
          model: activeProvider,
          modelId: answer.model,
          // An interpreted passage keeps the ORIGINAL speaker's timecode: that is where he
          // cuts the clip from, and the interpreter's audio cannot be used for it.
          timecode: originalTimecode(findQuoteTimecode(r.quote || r.point, windowSentences)),
        })),
      });
    }
  } catch (err) {
    console.error('[keypoints] error:', err);
  }
}

// Turn a transcript fragment the user marked (⭐) into a key point + learn from it.
// `speaker` comes from the overlay (nearest speaker header above the selection) and
// takes precedence over whatever the model guesses.
async function addManualKeyPoint(text, speaker, context, timecode) {
  if (!text || !text.trim()) return;
  addFeedback('pos', text);
  const catOther = promptLang().catOther;
  const spk = (speaker && speaker.trim()) ? speaker.trim() : null;
  const tc = (timecode && timecode.trim()) ? timecode.trim() : '';
  try {
    const { titleContext } = buildParticipantContext(pageTitle);
    const contextBlock = (context && context.trim())
      ? `Preceding transcript (CONTEXT ONLY — do NOT summarize this; use it to tell who is speaking and what the fragment refers to):\n"${context.trim()}"\n\n`
      : '';
    const answer = await callClaude(
      `${titleContext}${contextBlock}Fragment to turn into a key point: "${text}"`,
      manualKeypointPrompt(), false, 512, true
    );
    const kp = parseObject(answer.text);
    const result = (kp && kp.point)
      ? { point: kp.point, category: (kp.category || catOther).toUpperCase(), quote: kp.quote || text, speaker: spk || kp.speaker || null, dominantSpeakerId: null, model: activeProvider, modelId: answer.model, timecode: tc }
      : { point: text, category: catOther, quote: text, speaker: spk, dominantSpeakerId: null, model: activeProvider, modelId: answer.model, timecode: tc };
    rememberClaim(result.point);
    if (activeTabId) sendToTab(activeTabId, { type: 'NEW_KEYPOINTS', results: [result] });
  } catch (err) {
    console.error('[manual-keypoint] error:', err);
    if (activeTabId) sendToTab(activeTabId, { type: 'NEW_KEYPOINTS', results: [{ point: text, category: catOther, quote: text, speaker: spk, timecode: tc }] });
  }
}

// ── On-demand verification of a single key point ───────────────────────────────

async function verifyKeyPoint(id, claim, quote) {
  try {
    const dateCtx = pageDate ? `\nDate: ${pageDate}` : '';
    const titleCtx = pageTitle ? `Event: "${pageTitle}"${dateCtx}\n\n` : '';
    const quoteCtx = (quote && quote.trim()) ? `\nOriginal quote: "${quote}"` : '';
    const userMsg = `${titleCtx}Evaluate ONLY this claim:\n${claim}${quoteCtx}`;

    // Verification ALWAYS uses live web search (grounded) — a verdict from the model's
    // own (possibly stale) knowledge is worse than none for a fact-checking tool, so
    // there is NO ungrounded fallback. Run it SILENT and retry once if the search model
    // errors transiently (e.g. Groq compound 413); if it still fails, we return no
    // verdict and the card shows "No se pudo verificar."
    let { text, sources } = await callClaude(userMsg, verifyPrompt(), true, 768, false, true);
    let result = parseObject(text);
    if (!result || !result.verdict) {
      const retry = await callClaude(userMsg, verifyPrompt(), true, 768, false, true);
      result = parseObject(retry.text);
      sources = retry.sources;
    }

    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'KEYPOINT_VERDICT',
        id,
        result: result ? { ...result, sources: sources || [] } : null,
      });
    }
  } catch (err) {
    console.error('[verify] error:', err);
    if (activeTabId) sendToTab(activeTabId, { type: 'KEYPOINT_VERDICT', id, result: null });
  }
}

// ── Final summary (on demand) ──────────────────────────────────────────────────

async function summarizeSession(input) {
  try {
    const { text, model } = await callClaude(input, summaryPrompt(), false, 2048);
    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'SUMMARY_RESULT', text: stripMarkdown(text), provider: activeProvider, modelId: model,
      });
    }
  } catch (err) {
    console.error('[summary] error:', err);
    if (activeTabId) sendToTab(activeTabId, { type: 'SUMMARY_RESULT', text: '' });
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let activeTabId = null;
let isCapturing = false;

// Identifies the current session. It travels with START_FACTCHECK so the content
// script can tell "brand-new session" from "same session, the page just reloaded"
// and restore its saved transcript instead of starting blank (see SESSION_BACKUP_KEY
// in session-export.js).
let sessionId = null;
const SESSION_BACKUP_KEY = 'sessionBackup';

// With all_frames the content scripts run in every frame (so we can reach players
// inside cross-origin iframes, e.g. Vimeo embeds). Only ONE frame may capture audio:
// frames that find a media element ask for this slot and the first one wins.
let captureClaimedBy = null; // frameId of the frame that captures, or null
let captureMode = null;      // 'page' | 'device' — reported by the capturing frame
let gladiaSessionUrl = null; // live session of the CURRENT page, so a resume can end it

function sendToTab(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ── Translation ────────────────────────────────────────────────────────────────

// "en-US" → "en", so detected tags compare against the plain codes the user picked.
function baseLang(code) {
  return String(code || '').toLowerCase().split(/[-_]/)[0];
}

// Languages the user marked as understood are left untranslated. The decision uses the
// language Gladia detected for THIS utterance whenever it has one, and only falls back
// to the session setting (often 'auto') without it. It used to rely on the session
// setting alone, which in 'auto' sent every line to the translator and left the call to
// Google's detection — or, when Google failed, to an LLM that ignored the passthrough
// instruction and translated or even rewrote English lines (it swapped a politician's
// name for a different one, and the summary then repeated it).
function needsTranslation(detectedLanguage) {
  const lang = baseLang(detectedLanguage) || SOURCE_LANGUAGE;
  return !UNDERSTOOD_LANGS.includes(lang);
}

// Unofficial Google Translate endpoint (no key, no billing). Auto-detects the source
// (sl=auto) and translates into `targetCode` (our UI language, es/en). It's a REAL
// translator, so each sentence comes back complete — unlike the Groq model, which
// sometimes left fragments half-translated. Being unofficial it can rate-limit/block,
// so translateToUiLanguage falls back to Groq when it fails. Returns the translation
// plus the language Google detected (used to honour "languages I understand").
// Failures carry a `kind` so the user can be told WHY Google stopped answering instead of
// trusting a later test that happened to work: 'network' (no connection), 'http' (with
// `status`, 429 = rate limit), 'blocked' (a 200 whose body isn't JSON — Google's "unusual
// traffic" page), 'shape' (JSON we don't recognise).
function googleError(kind, message, extra) {
  return Object.assign(new Error(message), { kind }, extra || {});
}

async function translateWithGoogle(text, targetCode) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
    + encodeURIComponent(targetCode) + '&dt=t&q=' + encodeURIComponent(text);
  let res;
  // No cookies or referrer: the endpoint doesn't need them, and they would tie this
  // traffic to the user's Google identity. This does NOT avoid its HTTP 429s — tested: a
  // live foreign-language session still got 429 without cookies, while single requests
  // (curl, address bar, the extension itself) answered 200. The throttle is undocumented.
  try { res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }); }
  catch (err) { throw googleError('network', 'google translate network: ' + err.message); }
  if (!res.ok) throw googleError('http', 'google translate http ' + res.status, { status: res.status });
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); }
  catch { throw googleError('blocked', 'google translate non-JSON: ' + body.slice(0, 60).replace(/\s+/g, ' ')); }
  // Shape: [ [ [translatedChunk, originalChunk, ...], ... ], null, "<detectedLang>", ... ]
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw googleError('shape', 'google translate shape');
  const translated = data[0].map(seg => (Array.isArray(seg) && seg[0]) ? seg[0] : '').join('').trim();
  const detected = typeof data[2] === 'string' ? data[2] : '';
  return { translated, detected };
}

// Waits before each Google attempt. The unofficial endpoint throttles in bursts, and a
// quick double retry lost about a third of the lines in a real session. Translation
// arrives after its line is already on screen, so spacing attempts out costs nothing.
const GOOGLE_TRANSLATE_DELAYS = [0, 600, 1500, 3000];

// Circuit breaker. When the endpoint is throttling, retrying every line four times only
// quadruples the traffic that caused the throttle (a Finnish session lost Google on 100%
// of its lines). After a few lines fail completely, stop asking for a while and let the
// AI carry the translations; then probe Google again.
const GOOGLE_FAILED_LINES_BEFORE_PAUSE = 3;
const GOOGLE_PAUSE_MS = 90 * 1000;
let googleFailedLines = 0;
let googlePausedUntil = 0;
let googleWasPaused = false; // so its recovery can be announced once

// The reason, in the user's words, for the marker the panel shows and the export keeps.
function googleFailureReason(err) {
  switch (err && err.kind) {
    case 'network': return t('bg_gt_network');
    case 'http': return err.status === 429 ? t('bg_gt_ratelimit') : fmt(t('bg_gt_http'), { status: err.status });
    case 'blocked': return t('bg_gt_blocked');
    case 'shape': return t('bg_gt_shape');
    default: return (err && err.message) || '?';
  }
}

// A marker in the live transcript + a toast, logged into the export with its time.
function notifyTranslator(label) {
  if (activeTabId) sendToTab(activeTabId, { type: 'TRANSLATOR_STATUS', label });
}

// Translates one transcript line and reports each version through `report(text, source)`
// (source 'google' | 'ai'; an empty text means "show no translation").
//
// Google is the translator of record: it doesn't paraphrase or "correct" what was said.
// The moment its FIRST attempt fails, the AI is asked in parallel so the reader isn't left
// waiting, and its version is shown provisionally — badged, because an LLM can rewrite
// content. Google keeps retrying meanwhile, and if it gets through it REPLACES the AI
// version. A late AI answer never overwrites Google's. When Google succeeds on its first
// try, the AI is never called — so no request quota is spent on lines that didn't need it.
// `shouldStop()` (optional) ends the work early once a better translation arrived
// elsewhere (Gladia's): no more retries, no AI call, and it doesn't count as a failure.
async function translateLine(text, report, sourceCode, shouldStop) {
  if (!text || !text.trim()) return;
  const stopped = () => !!(shouldStop && shouldStop());
  const target = getUiLang();
  const source = baseLang(sourceCode);
  let settled = false;   // Google has the final word
  let aiRequested = false;
  let lastError = null;

  const askAi = () => {
    if (aiRequested || stopped()) return;
    aiRequested = true;
    callClaude(text, translatePrompt(source), false, 768, false, true)
      .then(r => {
        const out = stripMarkdown(r.text).trim();
        if (out && !settled && !stopped()) report(out, 'ai');
      })
      .catch(() => {});
  };

  // Google is resting after a run of failures: go straight to the AI.
  if (Date.now() < googlePausedUntil) { askAi(); return; }

  for (const delay of GOOGLE_TRANSLATE_DELAYS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (stopped()) return;
    try {
      const { translated, detected } = await translateWithGoogle(text, target);
      if (stopped()) return;
      settled = true;
      googleFailedLines = 0;
      if (googleWasPaused) { googleWasPaused = false; notifyTranslator(t('bg_gt_recovered')); }
      // Honour "languages I understand" when there was no per-utterance language to go
      // by — and take back a provisional AI version if one was already shown.
      if (detected && UNDERSTOOD_LANGS.includes(baseLang(detected))) {
        if (aiRequested) report('', 'google');
        return;
      }
      if (translated) { report(translated, 'google'); return; }
      settled = false;
      lastError = googleError('shape', 'google translate empty translation');
    } catch (err) {
      lastError = err;
    }
    if (stopped()) return;
    askAi();
    if (Date.now() < googlePausedUntil) return; // another line tripped the breaker meanwhile
  }
  console.warn(`[translate] Google failed ${GOOGLE_TRANSLATE_DELAYS.length}×: ${lastError && lastError.message} — the AI version stays`);
  if (++googleFailedLines >= GOOGLE_FAILED_LINES_BEFORE_PAUSE) {
    googleFailedLines = 0;
    googlePausedUntil = Date.now() + GOOGLE_PAUSE_MS;
    googleWasPaused = true;
    console.warn(`[translate] pausing Google for ${GOOGLE_PAUSE_MS / 1000}s after repeated failures`);
    notifyTranslator(fmt(t('bg_gt_paused'), { reason: googleFailureReason(lastError) }));
  }
}

// Computer-clock timecode HH:MM:SS:FF (FF = frame, 24 fps), captured when the
// sentence is finalized — before any translation latency.
function getClockTimecode() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// Identifies a final transcript line so its translation can find it later. Time-based,
// so ids never collide with lines restored from a backup after a browser restart.
let transcriptLineSeq = 0;

// ── Gladia's live translation ─────────────────────────────────────────────────
// Gladia translates every utterance itself, in the same pipeline as the transcription, so
// it is the primary translator; Google and then the AI only step in for a line Gladia
// hasn't translated within GLADIA_TRANSLATION_WAIT_MS. Its answer always wins: it replaces
// a fallback version already on screen, and fallback reports that come later are dropped.
//
// Matching a translation to its line: Gladia's docs show different formats for the
// transcript's `id` and the translation's `utterance_id`, so the id may not match. Then
// the utterance's start/end times, then its exact original text. Which one matched is
// logged, as evidence while this is on trial.
const GLADIA_TRANSLATION_WAIT_MS = 5000;
const GLADIA_EARLY_TRANSLATION_TTL_MS = 15000; // a translation that beat its line waits this long
const GLADIA_MAX_LINES = 300;
const GLADIA_TIME_TOLERANCE_S = 0.05;
const GLADIA_SILENT_LINES = 3; // lines that fell back with no Gladia translation ever seen
let gladiaTranslationActive = false;
let gladiaGeneration = 0;      // bumped per Gladia session: utterance ids restart on reconnect
let gladiaLines = [];          // recent final lines, oldest first
let gladiaEarlyTranslations = [];
let gladiaTranslationsSeen = 0;
let gladiaFallbackLines = 0;
let gladiaTranslatorAnnounced = false;

function resetGladiaTranslation() {
  gladiaTranslationActive = false;
  gladiaLines = [];
  gladiaEarlyTranslations = [];
  gladiaTranslationsSeen = 0;
  gladiaFallbackLines = 0;
  gladiaTranslatorAnnounced = false;
}

// `model` is Gladia's translation model, named in the marker so each export records which
// one produced it, and in the console so runs can be told apart there too.
function onGladiaSession(translation, model) {
  gladiaGeneration++;
  gladiaEarlyTranslations = [];
  gladiaTranslationActive = !!translation;
  console.log(`[translate] ── Gladia session started — translation ${gladiaTranslationActive ? 'on, model ' + (model || '?') : 'off'} ──`);
  if (gladiaTranslationActive && !gladiaTranslatorAnnounced) {
    gladiaTranslatorAnnounced = true;
    notifyTranslator(fmt(t('bg_tr_gladia_on'), { model: model || '?' }));
  }
}

function sameGladiaTime(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= GLADIA_TIME_TOLERANCE_S;
}

const GLADIA_MATCHERS = [
  ['id', (line, tr) => line.utteranceId != null && tr.utteranceId != null && String(line.utteranceId) === String(tr.utteranceId)],
  ['time', (line, tr) => sameGladiaTime(line.start, tr.start) && sameGladiaTime(line.end, tr.end)],
  ['text', (line, tr) => !!tr.original && line.text.trim() === tr.original],
];

// The newest untranslated line of this Gladia session that `tr` belongs to.
function findGladiaLine(tr) {
  for (const [method, matches] of GLADIA_MATCHERS) {
    for (let i = gladiaLines.length - 1; i >= 0; i--) {
      const line = gladiaLines[i];
      if (!line.gladiaDone && !line.gladiaRejected && line.generation === gladiaGeneration && matches(line, tr)) {
        return { line, method };
      }
    }
  }
  return null;
}

// Gladia sometimes hands back the original instead of a translation: in a Mandarin
// session 5 of 33 lines came back as the Chinese text split into words with spaces, one
// with only its last clause translated. Its live API has no way to ask again, so such a
// "translation" is refused and the line goes to the fallbacks. The script test assumes a
// Latin-script target, which holds for both UI languages (es, en).
function looksUntranslated(original, translation) {
  const squeeze = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const tr = squeeze(translation);
  if (!tr || tr === squeeze(original)) return true;
  const letters = [...tr].filter(c => /\p{L}/u.test(c));
  const foreign = letters.filter(c => !/\p{Script=Latin}/u.test(c)).length;
  if (foreign >= 10 || (letters.length && foreign / letters.length > 0.3)) return true;
  // Same script as the target (e.g. Finnish): most words carried over unchanged. Names
  // (capitalised) and numbers are the same in every language, so they don't count.
  const words = s => String(s || '').split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const originalWords = new Set(words(original).map(w => w.toLowerCase()));
  const plain = words(translation).filter(w => !/\d/.test(w) && w === w.toLowerCase());
  if (plain.length >= 3 && plain.filter(w => originalWords.has(w)).length / plain.length >= 0.8) return true;
  // A PART of the line can come back untranslated: a German line arrived with its
  // beginning and its end in Spanish and the middle still in German, which neither test
  // above sees. A stretch of words copied verbatim, in order, from the original is the
  // signature — a real translation never reproduces a whole clause word for word.
  return longestCopiedRun(original, translation) >= COPIED_RUN_WORDS;
}

const COPIED_RUN_WORDS = 6;

// Longest run of consecutive words present, in the same order, in both texts.
function longestCopiedRun(original, translation) {
  const words = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const a = words(original), b = words(translation);
  if (!a.length || !b.length) return 0;
  let best = 0;
  const row = new Array(a.length + 1).fill(0);
  for (let i = 1; i <= b.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= a.length; j++) {
      const above = row[j];
      row[j] = b[i - 1] === a[j - 1] ? diagonal + 1 : 0;
      if (row[j] > best) best = row[j];
      diagonal = above;
    }
  }
  return best;
}

function applyGladiaTranslation(line, tr, method) {
  const untranslated = line.needs && looksUntranslated(line.text, tr.text);
  // Even a line he understands feeds the interpretation index: its Spanish is what a later
  // interpreted line gets compared against (and vice versa). Nothing of this is shown.
  if (!untranslated) indexSpokenLine(line.timecode, line.language, tr.text);
  console.log(`[translate] gladia matched by ${method}, ${Date.now() - line.at} ms after its line` +
    (!line.needs ? ' (line needs no translation: ignored)'
      : untranslated ? ' — came back UNTRANSLATED, the fallbacks take over' : ''));
  if (untranslated) {
    line.gladiaRejected = true;
    if (line.startFallback) line.startFallback();
    return;
  }
  line.gladiaDone = true;
  if (!line.needs || activeTabId !== line.tabId) return;
  sendToTab(line.tabId, { type: 'TRANSCRIPT_TRANSLATION', lineId: line.lineId, translation: tr.text, source: 'gladia' });
}

function onGladiaTranslation(tr) {
  if (!activeTabId || !tr || !tr.text) return;
  gladiaTranslationsSeen++;
  const now = Date.now();
  gladiaEarlyTranslations = gladiaEarlyTranslations.filter(x => {
    if (now - x.at < GLADIA_EARLY_TRANSLATION_TTL_MS) return true;
    console.warn('[translate] gladia translation never matched a line:', x.tr);
    return false;
  });
  const found = findGladiaLine(tr);
  if (found) applyGladiaTranslation(found.line, tr, found.method);
  else gladiaEarlyTranslations.push({ tr, at: now });
}

function rememberGladiaLine(line) {
  gladiaLines.push(line);
  if (gladiaLines.length > GLADIA_MAX_LINES) gladiaLines.shift();
  for (const [method, matches] of GLADIA_MATCHERS) {
    const i = gladiaEarlyTranslations.findIndex(x => matches(line, x.tr));
    if (i >= 0) {
      const { tr } = gladiaEarlyTranslations.splice(i, 1)[0];
      console.log('[translate] gladia translation arrived before its line');
      applyGladiaTranslation(line, tr, method);
      break;
    }
  }
  return line;
}

// ── Interpreted events ────────────────────────────────────────────────────────
// A key point must carry the timecode of the ORIGINAL speaker: he cuts the clip from
// there, and the interpreter's audio is unusable for that. Consecutive interpretation
// repeats each statement in another language a few seconds later, and the interpreted
// version is often the FULLER one (the recogniser chops Mandarin into short utterances
// that Gladia then translates one by one), so the point may well be extracted from it.
//
// Everything is compared in Spanish: Gladia translates EVERY utterance, including the
// ones in a language he understands, which used to be thrown away. A line that covers
// what an earlier line in ANOTHER language said is the interpretation of it, and points
// found there keep the original's timecode.
const SPOKEN_INDEX_MS = 180000;
const SPOKEN_INDEX_MAX = 300;
const INTERPRETED_COVERAGE = 0.6;
let spokenIndex = [];                 // { timecode, lang, es, at }, oldest first
const interpretedOrigin = new Map();  // interpretation timecode → original timecode

function resetInterpretationIndex() {
  spokenIndex = [];
  interpretedOrigin.clear();
}

function contentWords(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4);
}

// Containment, not equality: one interpreted sentence usually covers several short
// original utterances, so the question is whether the earlier line is INSIDE this one.
function coversEarlier(words, earlierSpanish) {
  const earlier = contentWords(earlierSpanish);
  if (earlier.length < 3) return false;
  const seen = new Set(words);
  return earlier.filter(w => seen.has(w)).length / earlier.length >= INTERPRETED_COVERAGE;
}

function indexSpokenLine(timecode, lang, spanish) {
  if (!timecode || !spanish || interpretedOrigin.has(timecode)) return;
  const now = Date.now();
  spokenIndex = spokenIndex.filter(e => now - e.at < SPOKEN_INDEX_MS).slice(-SPOKEN_INDEX_MAX);
  const base = baseLang(lang);
  const words = contentWords(spanish);
  for (const e of spokenIndex) { // oldest first: the earliest original wins
    if (!e.es || (base && e.lang && e.lang === base)) continue;
    if (!coversEarlier(words, e.es)) continue;
    const origin = interpretedOrigin.get(e.timecode) || e.timecode;
    interpretedOrigin.set(timecode, origin);
    console.log(`[keypoints] ${timecode} repeats ${origin} in another language (interpretation) — key points keep ${origin}`);
    break;
  }
  spokenIndex.push({ timecode, lang: base, es: spanish, at: now });
}

// The timecode to show for a point found in an interpreted passage.
function originalTimecode(timecode) {
  return interpretedOrigin.get(timecode) || timecode;
}

function relayTranscript(msg, timecode) {
  if (!activeTabId) return;
  timecode = msg.isFinal ? (timecode || getClockTimecode()) : '';
  // Resolve a speaker label for the transcript (Gladia diarization). The overlay
  // shows it at the start and whenever the speaker changes.
  let speaker = null;
  if (msg.isFinal && msg.speaker !== null && msg.speaker !== undefined) {
    speaker = speakerIdToName[msg.speaker] || ('Orador ' + (Number(msg.speaker) + 1));
  }
  const lineId = msg.isFinal ? 'tl-' + Date.now().toString(36) + '-' + (++transcriptLineSeq) : null;

  // The line goes out at once; its translation follows as a separate message. Waiting
  // for the translation first delayed every line by the translator's retries and could
  // deliver a later line before an earlier one.
  const tabId = activeTabId;
  sendToTab(tabId, {
    type: 'TRANSCRIPT_RESULT',
    text: msg.text,
    isFinal: msg.isFinal,
    interim: msg.interim,
    timecode,
    translation: '',
    speaker,
    lineId,
  });

  if (!msg.isFinal) return;
  const needs = needsTranslation(msg.language);
  const report = (text, source) => {
    // The session may have ended, or moved to another tab, while we were translating.
    if (activeTabId !== tabId) return;
    indexSpokenLine(timecode, msg.language, text); // whoever translated it, Spanish is Spanish
    sendToTab(tabId, { type: 'TRANSCRIPT_TRANSLATION', lineId, translation: text, source });
  };

  // Already in the language the comparison uses: index it as it was said.
  if (baseLang(msg.language) === getUiLang()) indexSpokenLine(timecode, msg.language, msg.text);

  if (!gladiaTranslationActive) {
    if (needs) translateLine(msg.text, report, msg.language);
    return;
  }

  // Every final line is remembered, even one that needs no translation: Gladia translates
  // them all, and its translation must find its own line rather than a neighbour's.
  const line = {
    lineId, tabId, text: msg.text, needs, at: Date.now(), gladiaDone: false, gladiaRejected: false,
    generation: gladiaGeneration, utteranceId: msg.utteranceId ?? null,
    start: msg.start ?? null, end: msg.end ?? null,
    timecode, language: msg.language || '',
  };
  const gladiaWon = () => line.gladiaDone || activeTabId !== tabId;
  // Runs once: when Gladia is late, or at once when its answer came back untranslated.
  let fallbackStarted = false;
  line.startFallback = () => {
    if (!needs || fallbackStarted || gladiaWon()) return;
    fallbackStarted = true;
    if (!line.gladiaRejected && gladiaTranslationsSeen === 0 && ++gladiaFallbackLines === GLADIA_SILENT_LINES) {
      console.warn('[translate] gladia has sent no translation yet — the fallbacks are translating');
      notifyTranslator(t('bg_tr_gladia_silent'));
    }
    translateLine(msg.text, (text, source) => { if (!line.gladiaDone) report(text, source); }, msg.language, gladiaWon);
  };
  rememberGladiaLine(line);
  if (needs) setTimeout(line.startFallback, GLADIA_TRANSLATION_WAIT_MS);
}

// ── Messages ──────────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {

    case 'START_FACTCHECK':
      return startFactCheck();

    case 'STOP_FACTCHECK':
      stopFactCheck();
      return Promise.resolve({ ok: true });

    case 'TRANSCRIPT_RESULT':
      if (msg.isFinal) {
        if (msg.speaker !== null && msg.speaker !== undefined) {
          currentSpeakerId = msg.speaker;
          if (activeTabId && !confirmedSpeakers.has(currentSpeakerId) && !speakerIdToName[currentSpeakerId]) {
            sendToTab(activeTabId, {
              type: 'NEW_SPEAKER',
              speakerId: currentSpeakerId,
              sample: msg.text.slice(0, 80),
            });
          }
        }
        const tc = getClockTimecode();
        onNewSentence(msg.text, currentSpeakerId, tc);
        relayTranscript(msg, tc);
        return Promise.resolve();
      }
      relayTranscript(msg);
      return Promise.resolve();

    case 'SPEAKER_NAMES':
      if (msg.speakerIdToName) {
        Object.entries(msg.speakerIdToName).forEach(([id, name]) => {
          const numId = parseInt(id);
          if (!confirmedSpeakers.has(numId)) {
            speakerIdToName[numId] = name;
            confirmedSpeakers.add(numId);
          }
        });
      }
      return Promise.resolve();

    case 'PAGE_TITLE':
      pageTitle = msg.title || '';
      pageDate = msg.date || '';
      return Promise.resolve();

    case 'PIPELINE_ERROR':
      if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: msg.message });
      return Promise.resolve();

    case 'PIPELINE_INFO':
      if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_INFO', message: msg.message });
      return Promise.resolve();

    // The capturing frame (possibly an iframe) hears only silence — relay to the panel.
    case 'CAPTURE_SILENT':
      if (activeTabId) sendToTab(activeTabId, { type: 'CAPTURE_SILENT', message: msg.message, contextState: msg.contextState });
      return Promise.resolve();

    // How the page ended up capturing audio ('page' | 'device'). Kept here because the
    // background outlives the reload: on resume the content script needs to know whether
    // to wait for the player or go straight back to the audio device.
    case 'CAPTURE_MODE':
      captureMode = msg.mode === 'device' ? 'device' : 'page';
      return Promise.resolve();

    // Gladia's free plan allows one live session at a time. The page that owns it is
    // about to be destroyed by a reload, so remember it here: the resumed page reopens
    // it just to end it, freeing the slot before asking for a new one.
    case 'GLADIA_SESSION':
      gladiaSessionUrl = msg.url || null;
      onGladiaSession(msg.translation, msg.translationModel);
      return Promise.resolve();

    case 'GLADIA_TRANSLATION':
      onGladiaTranslation(msg);
      return Promise.resolve();

    case 'CAPTURE_READY':
      if (activeTabId) sendToTab(activeTabId, { type: 'CAPTURE_READY' });
      return Promise.resolve();

    case 'CLAIM_CAPTURE': {
      if (captureClaimedBy !== null) return Promise.resolve({ granted: false });
      captureClaimedBy = sender && sender.frameId !== undefined ? sender.frameId : 0;
      // Tell every frame the slot is taken, so the top frame cancels its fallback.
      if (activeTabId) sendToTab(activeTabId, { type: 'CAPTURE_CLAIMED' });
      return Promise.resolve({ granted: true });
    }

    case 'VERIFY_KEYPOINT':
      verifyKeyPoint(msg.id, msg.claim, msg.quote);
      return Promise.resolve();

    case 'FEEDBACK_NEGATIVE':
      addFeedback('neg', msg.text);
      return Promise.resolve();

    case 'FEEDBACK_POSITIVE':
      // 👍 The user reinforced a good key point — learn to prioritise its like.
      addFeedback('pos', msg.text);
      return Promise.resolve();

    case 'FEEDBACK_CORRECTION':
      // ✏️ The user rewrote a key point. The corrected wording is the "right" way to
      // capture it, so store it as a positive example (the export/card already show it).
      addFeedback('pos', msg.corrected);
      return Promise.resolve();

    case 'ADD_MANUAL_KEYPOINT':
      addManualKeyPoint(msg.text, msg.speaker, msg.context, msg.timecode);
      return Promise.resolve();

    case 'ADD_PARTICIPANT': {
      const name = (msg.name || '').trim();
      if (name) {
        const list = PARTICIPANTS ? PARTICIPANTS.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!list.includes(name)) {
          list.push(name);
          PARTICIPANTS = list.join(', ');
          browser.storage.local.set({ participants: PARTICIPANTS });
        }
      }
      return Promise.resolve();
    }

    case 'REMOVE_PARTICIPANT': {
      const name = (msg.name || '').trim();
      if (name) {
        const list = PARTICIPANTS ? PARTICIPANTS.split(',').map(s => s.trim()).filter(Boolean) : [];
        const idx = list.indexOf(name);
        if (idx !== -1) {
          list.splice(idx, 1);
          PARTICIPANTS = list.join(', ');
          browser.storage.local.set({ participants: PARTICIPANTS });
        }
      }
      return Promise.resolve();
    }

    case 'RENAME_PARTICIPANT': {
      const oldName = (msg.oldName || '').trim();
      const newName = (msg.newName || '').trim();
      if (oldName && newName) {
        const list = PARTICIPANTS ? PARTICIPANTS.split(',').map(s => s.trim()).filter(Boolean) : [];
        const idx = list.indexOf(oldName);
        if (idx !== -1) list[idx] = newName;
        else if (!list.includes(newName)) list.push(newName);
        PARTICIPANTS = list.join(', ');
        browser.storage.local.set({ participants: PARTICIPANTS });
      }
      return Promise.resolve();
    }

    case 'SUMMARIZE':
      summarizeSession(msg.input || '');
      return Promise.resolve();

    case 'GET_STATUS':
      return Promise.resolve({ isCapturing });

    // Content scripts have no access to browser.management, so the panel footer asks
    // us for its version label (see versionLabel() in lang.js).
    case 'GET_VERSION_LABEL':
      return versionLabel().then(label => ({ label }));
  }
});

// ── Start / stop ──────────────────────────────────────────────────────────────

async function startFactCheck() {
  if (isCapturing) return { ok: true };

  await loadKeys();
  if (!ANTHROPIC_KEY && !PROXY_URL) {
    throw new Error(getUiLang() === 'es'
      ? 'Configura una API key de Anthropic o una URL de proxy en el popup.'
      : 'Set an Anthropic API key or a proxy URL in the popup.');
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('No active tab found.');
  activeTabId = tabs[0].id;

  isCapturing = true;
  sessionId = Date.now();
  resetWindow();
  recentClaims.clear();
  captureClaimedBy = null;
  captureMode = null;
  gladiaSessionUrl = null;
  sessionStartedAt = Date.now();
  resetGladiaTranslation();
  resetInterpretationIndex();

  await sendToTab(activeTabId, { type: 'START_FACTCHECK', sessionId, resume: false });
  return { ok: true };
}

function stopFactCheck() {
  resetWindow();
  recentClaims.clear();
  pageTitle = '';
  pageDate = '';
  sessionStartedAt = null;
  captureClaimedBy = null;

  if (!isCapturing) return;

  if (activeTabId) sendToTab(activeTabId, { type: 'STOP_FACTCHECK' });

  // Drop the saved session: it only exists to survive a reload of a LIVE session.
  browser.storage.local.remove(SESSION_BACKUP_KEY).catch(() => {});

  activeTabId = null;
  sessionId = null;
  gladiaSessionUrl = null;
  resetGladiaTranslation();
  resetInterpretationIndex();
  isCapturing = false;
}

// ── Release notes after an update ─────────────────────────────────────────────
// Firefox updates the extension silently from updates.json, so the user would never
// find out what changed. Open the notes once, anchored at the new version. Skipped for
// builds loaded from disk, which would otherwise open a tab on every reload while
// developing.
const CHANGELOG_URL = 'https://oviiione.tngl.io/newspal/changelog.html';

browser.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  const version = browser.runtime.getManifest().version;
  if (reason !== 'update' || previousVersion === version) return;
  try {
    const info = await browser.management.getSelf();
    if (info && info.installType === 'development') return;
  } catch { /* couldn't tell — showing the notes is the harmless side */ }
  browser.tabs.create({ url: CHANGELOG_URL + '#v' + version });
});

// ── Surviving a page reload ───────────────────────────────────────────────────
// A reload (or a navigation) destroys everything that lives inside the page: the
// panel, the audio capture and the Gladia socket. This background script survives,
// so until now it kept reporting "active" while the user had no panel on screen and
// no transcription at all. Now it notices the reload and restarts the tab with the
// SAME sessionId, so the panel comes back with its transcript instead of blank.

let resumePending = false;

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!isCapturing || tabId !== activeTabId) return;
  if (changeInfo.status !== 'complete') return;
  resumeInTab();
});

// If the captured tab is closed there is nothing to come back to — stop for real, so
// the popup never claims to be active with no session behind it.
browser.tabs.onRemoved.addListener((tabId) => {
  if (isCapturing && tabId === activeTabId) stopFactCheck();
});

async function resumeInTab() {
  if (resumePending || !activeTabId) return;
  resumePending = true;
  captureClaimedBy = null; // the frames elect again who captures the audio
  const tabId = activeTabId;
  // The content scripts may still be booting, so retry briefly before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await browser.tabs.sendMessage(tabId, { type: 'START_FACTCHECK', sessionId, resume: true, captureMode, gladiaSessionUrl });
      resumePending = false;
      return;
    } catch {
      await new Promise(r => setTimeout(r, 700));
    }
  }
  resumePending = false;
  console.warn('[background] could not resume the session after the page reload');
}
