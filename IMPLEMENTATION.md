# Implementation progress

## Complete

- [x] Local React/TypeScript interface with series library and reading progress summary.
- [x] Pasted text and UTF-8 TXT import, bulk boundary detection/review, non-integer labels, original source preservation, and mapping notes.
- [x] Validated PNG/JPEG/WebP uploads with sanitized storage paths, tags, URLs, chapter labels, and spoiler-limit metadata fields.
- [x] SSRF-aware public URL discovery, redirect revalidation, explicit selection, size/type validation, and upload fallback.
- [x] Editable/versioned visual guide with explicit approval.
- [x] Sample-first generation and reuse of an approved sample page.
- [x] Persistent SQLite jobs, stage checkpoints, independent worker, restart recovery, cancellation boundaries, and retry checkpoint reuse.
- [x] Database-enforced active-job uniqueness and idempotent multi-click behavior.
- [x] Current-source-only adaptation context plus earlier continuity snapshots; imported future chapters are excluded.
- [x] Schema-validated stage data with passage IDs attached to events and panels.
- [x] Mock provider requiring no secrets and generating unmistakably labeled SVG placeholders.
- [x] Optional, fail-closed OpenAI text, vision, and image provider interfaces based on current official documentation.
- [x] Saved reader pages, scroll/single-page modes, RTL/LTR, zoom, keyboard navigation, chapter picker, Next chapter behavior, and editable lettering.
- [x] Localhost binding, server-only secrets, upload controls, filename sanitizing, path-safe storage, and private-network URL blocking.

## Verified locally

`npm.cmd test` runs isolated SQLite/API/worker tests for:

- Duplicate generation clicks result in one job.
- A complete mock job saves pages and reopening does not create a provider job.
- Future chapter text does not enter the current adaptation.
- Lettering changes leave artwork untouched.
- Missing source blocks generation and queued jobs can be cancelled.
- A restart requeues recoverable work and retry copies saved checkpoints.

`npm.cmd run build` type-checks the frontend/server/provider adapter and produces a Vite production client bundle.

## Next implementation priorities

- [ ] Store panel artwork as separate files and add single-panel revision/regeneration controls.
- [ ] Add page-fit analysis and explicit expand-range/condense choices.
- [ ] Add visual affected-continuity warnings and revision comparison tools.
- [ ] Add a reviewed paid-call consent screen with preflight cost policy enforcement.
- [ ] Add provider-specific reconciliation for ambiguous timeouts.
- [ ] Perform authorized real-provider smoke tests and record actual usage responses.
