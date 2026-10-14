# Novel to Manga

A personal, localhost-only workspace for importing novel chapters and visual references, generating one AI-assisted manga chapter at a time, and reading saved chapters. Mock mode is the safe default and makes no external or paid API calls.

## Run on Windows

Prerequisites: Node.js 22 or newer and npm.

```powershell
cd "C:\Users\sal8g\Downloads\Claude Codes\novel-to-manga"
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Open <http://127.0.0.1:5173>. The API binds to `127.0.0.1:4317`; both ports can be changed in `.env`. Use `npm.cmd` in PowerShell environments where script execution blocks `npm.ps1`.

Verify the project:

```powershell
npm.cmd test
npm.cmd run build
```

## First chapter

1. Create a series in the left sidebar.
2. Paste text or load a UTF-8 `.txt` file. Detect, correct, and save chapter boundaries and mapping notes.
3. Upload PNG/JPEG/WebP references, or inspect a public reference URL and explicitly select permitted images to import.
4. Create or edit the visual guide and approve it. In mock mode, image analysis creates a clearly marked template rather than pretending to inspect artwork.
5. Choose a chapter and page range, generate the sample, then approve it to generate the rest.
6. Open Reader. Lettering edits update coordinates/text only and do not regenerate artwork.
7. “Next chapter” opens saved output, reconnects to an existing job, starts exactly one new job, or redirects to import when source text is missing.

## Storage and architecture

- React + TypeScript frontend, Express + TypeScript API.
- SQLite data and job checkpoints in `data/novel-to-manga.sqlite`.
- Uploaded references and generated pages under `data/references` and `data/generated`.
- A separate worker process drains persistent jobs. Browser closure does not stop it.
- A partial unique SQLite index prevents more than one active job per chapter.
- Stage outputs, pages, continuity snapshots, revisions, and reading progress are persisted.
- Generated artwork and lettering JSON are separate. The current implementation generates one artwork canvas per page; lettering stays editable and free to change.

Do not commit `data/` or `.env`; both are ignored.

## Real OpenAI mode (disabled by default)

The optional adapter follows the current official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) and [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation). It uses schema-validated Responses API output, sends actual selected reference images for vision analysis, and uses the Images edit endpoint when reference images are available.

To configure it, edit `.env`:

```dotenv
PROVIDER_MODE=openai
OPENAI_API_KEY=your_server_side_key
OPENAI_TEXT_MODEL=gpt-5.6
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
ALLOW_PAID_PROVIDER_CALLS=true
MAX_JOB_SPEND_USD=5
```

For hybrid mode, set `PROVIDER_MODE=hybrid`, restart the app, then open Settings and choose **Continue with ChatGPT**. Adaptation and reference analysis use eligible ChatGPT plan usage. Because image generation is unsupported in the ChatGPT-plan OAuth preview, choose local placeholder artwork or separately billed API artwork with `IMAGE_PROVIDER_MODE`. The app stores OAuth credentials only in the ignored local SQLite data directory and never sends them to the browser.

For a zero-cost hybrid test, also set `IMAGE_PROVIDER_MODE=mock`. This uses the connected ChatGPT Plus/Pro plan for adaptation and reference analysis while rendering clearly labeled placeholder artwork locally. Set `IMAGE_PROVIDER_MODE=openai` only when you intend to authorize separately billed API image generation.

Real image calls still require explicit authorization on each job. The Generate screen includes an **Authorize paid artwork for this job** checkbox, which is off by default; environment values alone therefore cannot spend money. Keys stay server-side and are never returned by the settings endpoint. API usage is billed separately from ChatGPT subscriptions.

## Current limitations

- No paid provider request has been made, so real account access, model availability, output quality, and end-to-end billing remain unverified.
- The UI intentionally has no paid-call authorization control yet. Real mode is implemented server-side but fail-closed from the current UI.
- Page art is generated as one canvas, not independently composited panel image files. Text can be edited freely, but regenerating one visual panel without replacing the page canvas is not yet exposed.
- The target page range currently chooses the minimum value. Automatic fit analysis and an interactive “expand range vs. condense” decision are not yet implemented.
- URL import supports public, directly discoverable images only. Sites requiring JavaScript rendering, authentication, CAPTCHA, or anti-bot access fall back to uploads.
- Changing an earlier chapter invalidates later continuity records in storage, but the UI does not yet show an affected-chapter warning or offer revision management.
- Provider timeout reconciliation records ambiguous requests as `uncertain`; provider-specific lookup/reconciliation is not yet implemented, so the app will not blindly retry them.

See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for verification details and the remaining backlog.
