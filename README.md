# NewsPal — press-conference companion (Firefox fork)

> **This is a fork.** The original project is
> [rpanigrahi222/intruth-factcheck](https://github.com/rpanigrahi222/intruth-factcheck),
> a real-time fact-checking Chrome extension. All credit for the original idea and
> implementation goes to its author. This fork adapts it into a personal
> **press-conference companion for Firefox**, and that is where all new development
> happens (`firefox-extension/`).

## What this fork does

![The NewsPal overlay following a live speech: timecoded transcript at the top, extracted key points below — each with speaker, category, quote, verify button and 👎 feedback](docs/overlay-example.jpg)

Follow a live press conference (or speech, debate, interview) playing in a browser
tab and, in real time:

- **Transcribe** the audio — Gladia real-time API (14 languages + auto-detect) or a
  local Whisper model as fallback (no key needed).
- **Translate** every language you haven't marked as "understood" into your working
  language, line by line.
- **Extract neutral key points** — announcements, figures, commitments, notable
  quotes, geopolitical positions — attributed to the participants you define.
  No verdicts, no interpretation: just what was said.
- **Learn from your feedback** — 👎 discards a point (and teaches it to avoid similar
  ones), ⭐ on selected transcript text adds a missed point (and teaches it to look
  for more). Every few feedbacks the examples are auto-distilled into a short list of
  editable rules ("Reglas aprendidas" in the popup) that are applied every time.
- **Summarize on demand** — a narrative summary, plus a full session export
  (transcript with timecodes, key points, summary) as an HTML report.
- **Bilingual** — the popup has an "Idioma / Language" switch (Español | English)
  that drives both the interface and the language the AI writes in (key points,
  summary, learned rules). It defaults to your browser's language.
- **Verify on demand** — per-key-point web-grounded verification. *Currently
  disabled:* web search is not usable on Groq's free tier; the code path is kept for
  when a search-capable provider is configured.

## Main differences from the original

| | Original (Chrome) | This fork (Firefox) |
|---|---|---|
| Browser | Chrome MV3 | Firefox MV2, signed by Mozilla — installs permanently |
| Audio | `tabCapture` | The page's own `<video>/<audio>` element — including players inside cross-origin iframes (e.g. Vimeo embeds) — or a system loopback input device. No audio drivers or system software needed. |
| Output | Instant TRUE/FALSE-style verdicts per claim | Neutral key points; verification only on demand |
| Languages | English | 14 languages + auto-detect; bilingual UI/output (Español \| English); configurable list of languages that skip translation |
| AI providers | Anthropic key in the browser | Groq (free, default) / Gemini / Claude behind a small proxy (`proxy/`, deployable on Railway) so no API key ever lives in the browser; access gated by a shared token |
| Personalization | — | Feedback learning (examples + auto-distilled editable rules), participants bar, draggable/resizable panel |

## Repository layout

- `firefox-extension/` — the fork's extension (active development)
- `proxy/` — minimal proxy that keeps all API keys server-side (Railway)
- `site/` — static download page (served via Tangled sites) with the signed `.xpi`
  and the `updates.json` Firefox polls for auto-updates
- `realtime-factcheck/` — the original Chrome extension, kept for reference

## Installing

- [![Tangled](docs/tangled-logo.svg) DOWNLOAD PAGE](https://oviiione.tngl.io/newspal/)
- [![GitHub](docs/github-logo.svg) RELEASES](https://github.com/OviiiOne/newspal/releases)

**Regular install (recommended):** get the signed `.xpi` from either option
above and open it with Firefox (from the download page it installs on click).
The extension installs permanently — no developer mode needed — and versions
with auto-update support keep themselves current.

**Development (temporary add-on):** open `about:debugging` → *This Firefox* →
*Load Temporary Add-on…* and pick `firefox-extension/manifest.json`. It unloads
when Firefox closes, but settings and learned rules persist (fixed add-on id).

## Using it

1. In the extension popup choose **Proxy** mode and set the proxy URL + token
   (or provide your own API keys directly), the source language and, optionally,
   the participants.
2. Open the page with the video, **press play (unmuted)**, then hit *Start*.

## Deploying the proxy (recommended)

`proxy/` is a tiny Express server that keeps every API key on the server, so
nothing sensitive ever lives in the browser. Access is gated by a shared token.
On [Railway](https://railway.app) (free tier is enough):

1. Fork this repo to your own GitHub account.
2. Railway → *New Project* → *Deploy from GitHub repo* → pick your fork and branch.
3. In the service settings set **Root Directory** to `proxy`.
4. Add the environment variables:
   - `MISTRAL_API_KEY` — free "Experiment" tier at
     [console.mistral.ai](https://console.mistral.ai) (first provider in the queue)
   - `GLADIA_API_KEY` — free 10h/month at [gladia.io](https://gladia.io) (real-time transcription)
   - `PROXY_TOKEN` — any long random string; the extension popup must send the same one
   - optional (free fallback models for the provider queue): `CEREBRAS_API_KEY`
     ([cloud.cerebras.ai](https://cloud.cerebras.ai)) and `GROQ_API_KEY`
     ([console.groq.com](https://console.groq.com))
   - optional: `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` if you use those providers
   - optional model pins — `MISTRAL_MODEL`, `CEREBRAS_MODEL`, `GROQ_MODEL`. Normally
     you don't need these: the proxy asks each provider which models the key can call
     (`GET /v1/models`) and picks the best available one, so a retired model heals
     itself instead of breaking the whole queue. Set a variable only to force one
     specific model. `GET /health` reports what each provider resolved to.
   - do **not** set `ALLOWED_ORIGIN` (it must stay `*` for a browser extension)
5. Generate a public domain (*Settings → Networking*) and put that URL plus your
   `PROXY_TOKEN` in the popup, Proxy mode.

Any Node host works the same way (Render, Fly.io, your own server):
`cd proxy && npm install && node server.js`.

## Limitations

Transcription and key-point extraction are AI-based and imperfect: expect occasional
misheard names, missed points or clumsy phrasing. Nothing is ever presented as
fact-checked unless an explicit verification ran and is marked as such. Transcript
text is sent to the transcription/AI providers you configure — bring your own keys,
nothing is collected by this repo.

## Mirrors

This repository is published on
[GitHub](https://github.com/OviiiOne/newspal) and
[Tangled](https://tangled.org/oviiione.eurosky.social/newspal).

## License

MIT (same as the original project).
