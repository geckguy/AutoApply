<p align="center">
  <img src="backend/dashboard/logo.svg" width="88" alt="AutoApply logo">
</p>

<h1 align="center">AutoApply</h1>

<p align="center">
  <strong>Prepare faster. Review everything. Submit yourself.</strong>
</p>

<p align="center">
  A job application assistant for Firefox, Chrome, Edge, and Brave. It fills in the details you
  already saved, and lets you check everything before you submit.
</p>

<p align="center">
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.11%2B-17213A?style=flat-square&logo=python&logoColor=91A4FF" alt="Python 3.11+"></a>
  <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-Local_backend-17213A?style=flat-square&logo=fastapi&logoColor=52BFAE" alt="FastAPI local backend"></a>
  <a href="https://www.mozilla.org/firefox/"><img src="https://img.shields.io/badge/Firefox-Supported-17213A?style=flat-square&logo=firefoxbrowser&logoColor=F47D68" alt="Firefox supported"></a>
  <a href="https://www.google.com/chrome/"><img src="https://img.shields.io/badge/Chrome-Supported-17213A?style=flat-square&logo=googlechrome&logoColor=91A4FF" alt="Chrome supported"></a>
  <a href="https://www.microsoft.com/edge"><img src="https://img.shields.io/badge/Edge-Supported-17213A?style=flat-square&logo=microsoftedge&logoColor=52BFAE" alt="Microsoft Edge supported"></a>
  <a href="https://brave.com/"><img src="https://img.shields.io/badge/Brave-Supported-17213A?style=flat-square&logo=brave&logoColor=F47D68" alt="Brave supported"></a>
</p>

<p align="center">
  <a href="https://ai.google.dev/gemini-api"><img src="https://img.shields.io/badge/Gemini-Direct-526CE7?style=flat-square&logo=googlegemini&logoColor=white" alt="Google Gemini supported directly"></a>
  <a href="https://openrouter.ai/"><img src="https://img.shields.io/badge/OpenRouter-Choose_your_model-526CE7?style=flat-square&logo=openrouter&logoColor=white" alt="Choose any available OpenRouter model"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-52BFAE?style=flat-square&logo=opensourceinitiative&logoColor=17213A" alt="MIT License"></a>
</p>

AutoApply is a browser extension plus a small app that runs on your computer. It reads a job
application form, fills in what it already knows from your profile and resume, and asks the AI
service you choose when it needs help. You review everything before anything is submitted.

> AutoApply never clicks the final **Submit** button. You stay in control of every application.

## Why AutoApply

| | |
|---|---|
| **Kept on your computer** | Your profile, resumes, and application history are stored locally. Only what a question needs goes to the AI service you choose. |
| **Review-first** | Inspect and edit every prepared field before filling the page. |
| **Your choice of AI service** | Google Gemini, OpenRouter, or OpenCode Go. Swap it whenever you like. |
| **Cross-browser** | Install on Firefox or Chromium browsers including Chrome, Edge, and Brave. |

## Features

- Reuses your profile, resume, fill rules, saved answers, and learned corrections
- Prepares each field and flags anything worth a second look
- Handles multi-page forms, and stops before submission
- Prepares several applications at once from a list of job links
- Writes tailored answers, cover letters, match scores, and resume versions
- Tracks applications, follow-ups, interviews, contacts, and submission records
- Supports light, dark, and system themes across the dashboard and extension
- Works with Workday, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters, Taleo, Oracle, and any
  other page that has an application form on it

## How it works

```mermaid
flowchart LR
    A["Job application page"] --> B["The AutoApply extension<br/>reads the form and the job details"]
    B --> C["AutoApply on your computer"]
    C --> D{"Can AutoApply answer this<br/>from what you saved?"}
    D -->|"Yes"| E["Your profile, resume,<br/>fill rules and saved answers"]
    D -->|"No"| F["The AI service you chose<br/>Gemini, OpenRouter or OpenCode Go"]
    E --> G["You review the prepared fields"]
    F --> G
    G --> H["You fill when you're ready"]
    H --> I["You check everything, then submit"]
    I --> J["Application and submission<br/>records are saved in AutoApply"]
```

Anything AutoApply can answer from your saved information is resolved locally. It only reaches for
the AI service when it has to, and every route ends with your review before submission.

## AI model support

AutoApply supports three AI services:

- **Google Gemini** — direct integration using Gemini 2.5 Flash
- **OpenRouter** — set `OPENROUTER_MODEL` to any model available to your OpenRouter account
- **OpenCode Go** — an OpenAI-compatible subscription gateway that serves many open models (DeepSeek, Kimi, GLM, Qwen, MiniMax …) behind one key; set `AI_PROVIDER=opencode`, `OPENCODE_API_KEY` and `OPENCODE_MODEL` (for example `deepseek-v4.1-flash`). Run `curl -H "Authorization: Bearer $OPENCODE_API_KEY" https://opencode.ai/zen/go/v1/models` to list the ids your subscription can use.

This gives you a broad choice of models without tying AutoApply to one AI company. Any other OpenAI-compatible gateway works through the same client — point `OPENCODE_BASE_URL` at it and set `OPENCODE_API_KEY`/`OPENCODE_MODEL` accordingly.

## Quick start

### 1. Start AutoApply

**Double-click the launcher — no terminal needed.**

1. Download the project (on GitHub: **Code** → **Download ZIP**) or clone it.
2. Double-click **`start-autoapply.command`** on macOS or Linux, or **`start-autoapply.bat`** on
   Windows.
3. The first run takes a few minutes while AutoApply sets itself up. Your browser then opens on
   the dashboard. Keep the small window that appears open while you use AutoApply — closing it
   stops AutoApply.

You don't need a key just to start. The dashboard shows what's left to set up and asks you to
choose an AI service the first time you need one.

**Alternative: the terminal, for developers**

```bash
git clone https://github.com/geckguy/AutoApply.git
cd AutoApply
./setup.sh
```

Configure one AI service in `backend/.env`:

```env
# Gemini
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
```

or:

```env
# Any model available through OpenRouter.
# OPENROUTER_MODEL is required. With no model set, every AI request is refused
# and the extension falls back to your saved answers only.
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=provider/model-name
OPENROUTER_PRIVACY_MODE=strict
```

Start AutoApply:

```bash
source backend/venv/bin/activate
python -m backend.main
```

Open the dashboard at [http://127.0.0.1:8000/dashboard](http://127.0.0.1:8000/dashboard).

AutoApply listens on this computer at port 8000 by default. Set `AUTOAPPLY_HOST` / `AUTOAPPLY_PORT`
in `backend/.env` to change that; the dashboard works on any port, but the extension has to be
told where to find it, so put the same address in the extension's **Address** field (for example
`http://127.0.0.1:8123`) and save it.

### 2. Load the extension

#### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `extension/manifest.json`.

#### Chrome, Edge, or Brave

1. Open the browser's extensions page and enable **Developer mode**.
2. Choose **Load unpacked**.
3. Select the `extension-chrome/` folder.

## How to use it

1. Add your profile, resume, and reusable details in the dashboard.
2. Visit a job application page.
3. Click the AutoApply chip on the page, or press `Ctrl+Shift+A`.
4. Review the prepared fields and correct anything you don't like.
5. Choose **Fill & continue**, **Fill without continuing**, or **Fill and continue
   automatically**.
6. Check the completed application and submit it yourself.

AutoApply has tailored handling for Workday, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters,
Taleo, and Oracle. On any other page it looks for the form itself, and if it still isn't sure
there's an application there, you can tell it to go ahead anyway.

## Privacy and safety

- Everything you enter in AutoApply is filed under `backend/data/` on your computer.
- AutoApply listens on this computer only, and rejects any request whose `Host` header is not
  `localhost`, `127.0.0.1`, or `[::1]`. That check is what stops a public page from using
  DNS rebinding to reach it.
- Browser requests are accepted from a page served by AutoApply itself or from a pinned
  AutoApply extension id (`autoapply@local`, or the published Chrome id). Requests with no
  `Origin` header — local command-line tools and scripts — are accepted, because the `Host`
  check above is what keeps other machines out.
- There are no AutoApply accounts, analytics, or telemetry.
- When AutoApply cannot answer a question from what you saved, it sends your resume text, the job
  details on the page, and the profile fields that answer depends on to the AI service you chose.
  That is the only traffic that leaves your computer.
- Sensitive authentication, payment, and government-ID fields are excluded.
- Auto-run moves through safe form steps but never submits an application.

Review the privacy terms of the AI service you choose before sending resume or profile information. OpenRouter strict mode requests providers that deny data collection and support zero data retention.

`AUTOAPPLY_ALLOWED_HOSTS` and `AUTOAPPLY_EXTENSION_IDS` in `backend/.env` add extra hostnames
or extension ids to the defaults, for example a reverse-proxy hostname or a locally built
extension. Leave them empty unless you need them.

`backend/.env` is gitignored and no key has ever been committed, but it does live in this
directory: if you have shared, synced, or backed up the folder, rotate the AI service keys
(`GEMINI_API_KEY` / `OPENROUTER_API_KEY`) and issue replacements.

## Development

Run the complete local check suite:

```bash
bash scripts/check.sh
```

It compiles the Python sources, runs the unit tests, checks every JavaScript file for syntax
errors, runs the browser-side safety tests, validates both extension manifests, checks that no
internal vocabulary has crept back into user-facing copy, and fails if `extension-chrome/` has
drifted from `extension/`.

```text
start-autoapply.command  Double-click launcher (macOS, Linux)
start-autoapply.bat      Double-click launcher (Windows)
setup.sh                 Terminal install, for developers
backend/                 FastAPI service and dashboard
extension/               Firefox extension (canonical source for both packages)
extension-chrome/        Chrome, Edge, and Brave extension (generated)
scripts/                 check.sh, sync-extension.sh
tests/                   Backend and browser safety tests
```

`extension/` is the single source of truth. Chrome cannot load scripts from outside its own
extension directory, so `extension-chrome/` holds copies of the shared files plus its own
`manifest.json` and a small `browser` shim in `background/background.js`. After editing
anything under `extension/`, regenerate the Chromium tree:

```bash
bash scripts/sync-extension.sh          # rewrite extension-chrome/
bash scripts/sync-extension.sh --check  # verify without writing (check.sh runs this)
```

`backend/requirements.txt` lists the direct dependencies; `backend/requirements.lock` pins the
fully resolved set (including transitive packages) for a reproducible install.

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>Built with ❤️ and way too many job applications.</strong><br>
  <sub>If AutoApply saved you time, consider giving it a ⭐</sub>
</p>
