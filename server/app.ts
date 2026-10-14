import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileTypeFromFile } from "file-type";
import type { Db } from "./db";
import { config } from "./config";
import { analyzeReferenceImages } from "./providers";
import { bulkImportSchema, jobOptionsSchema } from "./schemas";

const now = () => new Date().toISOString();
const json = (value: string | null | undefined, fallback: unknown) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };

export function createApp(db: Db) {
  const app = express();
  const tempDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const upload = multer({ dest: tempDir, limits: { fileSize: config.maxUploadBytes, files: 12 } });
  app.use(cors({ origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ }));
  app.use(express.json({ limit: "2mb" }));
  app.use("/files/generated", express.static(path.join(config.dataDir, "generated"), { fallthrough: false, index: false }));
  app.use("/files/references", express.static(path.join(config.dataDir, "references"), { fallthrough: false, index: false }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, providerMode: config.providerMode, paidCallsEnabled: config.allowPaidCalls, database: "sqlite", workerRequired: true }));
  app.get("/api/settings", (_req, res) => res.json({ providerMode: config.providerMode, paidCallsEnabled: config.allowPaidCalls, maxPages: config.maxPages, maxJobSpendUsd: config.maxJobSpendUsd, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY), dataDir: config.dataDir, privacy: "Selected chapter text and reference images are sent to the configured external provider only in real provider mode. Mock mode stays local." }));

  app.get("/api/series", (_req, res) => {
    const rows = db.prepare(`SELECT s.*, COUNT(DISTINCT c.id) chapter_count, COUNT(DISTINCT CASE WHEN c.status='completed' THEN c.id END) completed_count, MAX(CASE WHEN g.approved=1 THEN 1 ELSE 0 END) guide_approved FROM series s LEFT JOIN chapters c ON c.series_id=s.id LEFT JOIN visual_guides g ON g.series_id=s.id GROUP BY s.id ORDER BY s.created_at DESC`).all() as any[];
    res.json(rows.map(r => ({ id: r.id, title: r.title, description: r.description, createdAt: r.created_at, chapterCount: r.chapter_count, completedCount: r.completed_count, guideApproved: Boolean(r.guide_approved), readingChapterId: r.reading_chapter_id })));
  });
  app.post("/api/series", (req, res) => {
    const title = String(req.body.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "Title is required." });
    const id = randomUUID();
    db.prepare("INSERT INTO series(id,title,description,created_at) VALUES(?,?,?,?)").run(id, title, String(req.body.description ?? ""), now());
    res.status(201).json({ id, title });
  });
  app.get("/api/series/:id", (req, res) => {
    const series = db.prepare("SELECT * FROM series WHERE id=?").get(req.params.id);
    if (!series) return res.status(404).json({ error: "Series not found." });
    const chapters = db.prepare("SELECT * FROM chapters WHERE series_id=? ORDER BY sort_order").all(req.params.id).map(mapChapter);
    const references = db.prepare("SELECT * FROM reference_images WHERE series_id=? ORDER BY created_at").all(req.params.id).map(mapReference);
    const guide = db.prepare("SELECT * FROM visual_guides WHERE series_id=? ORDER BY version DESC LIMIT 1").get(req.params.id) as any;
    res.json({ series, chapters, references, guide: guide && { id: guide.id, content: guide.content, approved: Boolean(guide.approved), version: guide.version } });
  });

  app.post("/api/series/:id/detect-chapters", (req, res) => {
    const text = String(req.body.text ?? "").replace(/^\uFEFF/, "");
    if (!text.trim()) return res.status(400).json({ error: "Text is required." });
    res.json({ chapters: detectChapters(text) });
  });
  app.post("/api/series/:id/chapters", (req, res) => {
    const parsed = bulkImportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    const max = (db.prepare("SELECT MAX(sort_order) n FROM chapters WHERE series_id=?").get(req.params.id) as any)?.n ?? 0;
    const insert = db.prepare("INSERT INTO chapters VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const ids: string[] = [];
    const transaction = db.transaction(() => parsed.data.chapters.forEach((ch, i) => { const id = randomUUID(); ids.push(id); insert.run(id, req.params.id, ch.identifier, ch.title, max + i + 1, ch.sourceText, ch.sourceKind, JSON.stringify(ch.sourceMetadata), ch.mappingNote, "imported", now()); }));
    try { transaction(); res.status(201).json({ ids }); } catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.put("/api/chapters/:id", (req, res) => {
    const before = db.prepare("SELECT * FROM chapters WHERE id=?").get(req.params.id) as any;
    if (!before) return res.status(404).json({ error: "Chapter not found." });
    const sourceText = String(req.body.sourceText ?? before.source_text);
    db.transaction(() => {
      db.prepare("UPDATE chapters SET identifier=?, title=?, source_text=?, mapping_note=? WHERE id=?").run(String(req.body.identifier ?? before.identifier), String(req.body.title ?? before.title), sourceText, String(req.body.mappingNote ?? before.mapping_note), req.params.id);
      if (sourceText !== before.source_text) db.prepare(`UPDATE continuity SET invalidated=1 WHERE series_id=? AND chapter_id IN (SELECT id FROM chapters WHERE series_id=? AND sort_order>?)`).run(before.series_id, before.series_id, before.sort_order);
    })();
    res.json({ ok: true });
  });

  app.post("/api/series/:id/references", upload.array("images", 12), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    const seriesId = String(req.params.id);
    const dir = path.join(config.dataDir, "references", seriesId);
    fs.mkdirSync(dir, { recursive: true });
    const added: any[] = [];
    try {
      for (const file of files) {
        const detected = await fileTypeFromFile(file.path);
        if (!detected || !allowed.has(detected.mime)) throw new Error(`${file.originalname} is not a supported PNG, JPEG, or WebP image.`);
        const safeBase = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || `reference.${detected.ext}`;
        const id = randomUUID(); const stored = `${id}-${safeBase}`; const destination = path.join(dir, stored);
        fs.renameSync(file.path, destination);
        const tags = String(req.body.tags ?? "general style").split(",").map((s: string) => s.trim()).filter(Boolean);
        db.prepare("INSERT INTO reference_images VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, seriesId, safeBase, destination, detected.mime, JSON.stringify(tags), req.body.sourceUrl || null, req.body.chapterLabel || null, req.body.maxReferenceChapter || null, now());
        added.push({ id, filename: safeBase, tags, url: `/files/references/${seriesId}/${stored}` });
      }
      res.status(201).json({ references: added });
    } catch (error) { files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); }); res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/series/:id/reference-url/discover", async (req, res) => {
    try { const result = await discoverImages(String(req.body.url ?? "")); res.json(result); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error), fallback: "Upload PNG, JPEG, or WebP files instead." }); }
  });
  app.post("/api/series/:id/reference-url/import", async (req, res) => {
    const urls = Array.isArray(req.body.urls) ? req.body.urls.slice(0, 12).map(String) : [];
    if (!urls.length) return res.status(400).json({ error: "Select at least one discovered image." });
    const dir = path.join(config.dataDir, "references", String(req.params.id)); fs.mkdirSync(dir, { recursive: true });
    const added: any[] = [];
    try {
      for (const raw of urls) {
        const response = await fetchPublic(raw);
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > config.maxUploadBytes) throw new Error("A selected image exceeds the upload limit.");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > config.maxUploadBytes) throw new Error("A selected image exceeds the upload limit.");
        const detected = await import("file-type").then(m => m.fileTypeFromBuffer(bytes));
        if (!detected || !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) throw new Error("A selected URL is not a supported PNG, JPEG, or WebP image.");
        const id = randomUUID(); const stored = `${id}-web-reference.${detected.ext}`; const destination = path.join(dir, stored); fs.writeFileSync(destination, bytes);
        const tags = String(req.body.tags ?? "general style").split(",").map((s: string) => s.trim()).filter(Boolean);
        db.prepare("INSERT INTO reference_images VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, req.params.id, `web-reference.${detected.ext}`, destination, detected.mime, JSON.stringify(tags), raw, req.body.chapterLabel || null, req.body.maxReferenceChapter || null, now());
        added.push({ id, url: `/files/references/${req.params.id}/${stored}` });
      }
      res.status(201).json({ references: added });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error), fallback: "Download permitted images yourself and use file upload." }); }
  });
  app.post("/api/series/:id/guide/analyze", async (req, res) => {
    const refs = db.prepare("SELECT file_path FROM reference_images WHERE series_id=?").all(req.params.id) as any[];
    if (!refs.length) return res.status(400).json({ error: "Upload at least one reference image first." });
    try {
      const content = await analyzeReferenceImages(refs.map(r => r.file_path), Boolean(req.body.paidCallsAuthorized));
      const version = ((db.prepare("SELECT MAX(version) n FROM visual_guides WHERE series_id=?").get(req.params.id) as any)?.n ?? 0) + 1;
      const id = randomUUID(); db.prepare("INSERT INTO visual_guides VALUES(?,?,?,?,?,?)").run(id, req.params.id, content, 0, version, now());
      res.status(201).json({ id, content, approved: false, version });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.put("/api/series/:id/guide", (req, res) => {
    const latest = db.prepare("SELECT * FROM visual_guides WHERE series_id=? ORDER BY version DESC LIMIT 1").get(req.params.id) as any;
    const content = String(req.body.content ?? latest?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "Guide content is required." });
    if (latest) db.prepare("UPDATE visual_guides SET content=?, approved=?, updated_at=? WHERE id=?").run(content, req.body.approved ? 1 : 0, now(), latest.id);
    else db.prepare("INSERT INTO visual_guides VALUES(?,?,?,?,?,?)").run(randomUUID(), req.params.id, content, req.body.approved ? 1 : 0, 1, now());
    res.json({ ok: true });
  });

  app.post("/api/jobs", (req, res) => {
    const parsed = jobOptionsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    const opts = parsed.data;
    const chapter = db.prepare("SELECT * FROM chapters WHERE id=?").get(opts.chapterId) as any;
    if (!chapter?.source_text.trim()) return res.status(409).json({ code: "source_missing", error: "Import the novel chapter before generating it." });
    const guide = db.prepare("SELECT 1 FROM visual_guides WHERE series_id=? AND approved=1").get(chapter.series_id);
    if (!guide) return res.status(409).json({ code: "guide_unapproved", error: "Approve the visual guide first." });
    const existing = db.prepare("SELECT * FROM jobs WHERE chapter_id=? AND status IN ('queued','running','cancel_requested','uncertain') ORDER BY created_at DESC LIMIT 1").get(chapter.id) as any;
    if (existing) return res.json(mapJob(existing));
    if (chapter.status === "completed" && !req.body.regenerate) return res.json({ state: "completed", chapterId: chapter.id });
    const id = randomUUID(); const total = opts.sampleOnly ? 1 : Math.min(opts.pageMin, config.maxPages);
    try {
      db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, chapter.series_id, chapter.id, "queued", "queued", 0, total, opts.mode, opts.pageMin, Math.min(opts.pageMax, config.maxPages), opts.sampleOnly ? 1 : 0, config.providerMode, opts.paidCallsAuthorized ? 1 : 0, 0, null, null, null, now(), now());
      db.prepare("UPDATE chapters SET status='generating' WHERE id=? AND status!='completed'").run(chapter.id);
      res.status(201).json(mapJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any));
    } catch {
      const raced = db.prepare("SELECT * FROM jobs WHERE chapter_id=? AND status IN ('queued','running','cancel_requested','uncertain') ORDER BY created_at DESC LIMIT 1").get(chapter.id) as any;
      res.json(mapJob(raced));
    }
  });
  app.get("/api/jobs/:id", (req, res) => { const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id) as any; row ? res.json(mapJob(row)) : res.status(404).json({ error: "Job not found." }); });
  app.post("/api/jobs/:id/cancel", (req, res) => { const result = db.prepare("UPDATE jobs SET cancel_requested=1, status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END, updated_at=? WHERE id=? AND status IN ('queued','running')").run(now(), req.params.id); res.json({ changed: result.changes }); });
  app.post("/api/jobs/:id/retry", (req, res) => {
    const old = db.prepare("SELECT * FROM jobs WHERE id=? AND status IN ('failed','cancelled')").get(req.params.id) as any;
    if (!old) return res.status(409).json({ error: "Only failed or cancelled jobs can be retried." });
    const active = db.prepare("SELECT * FROM jobs WHERE chapter_id=? AND status IN ('queued','running','cancel_requested','uncertain') LIMIT 1").get(old.chapter_id) as any;
    if (active) return res.json(mapJob(active));
    const id = randomUUID();
    db.transaction(() => {
      db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, old.series_id, old.chapter_id, "queued", "queued", 0, old.total_pages, old.mode, old.page_min, old.page_max, old.sample_only, old.provider_mode, old.paid_calls_authorized, 0, null, null, null, now(), now());
      db.prepare("INSERT INTO stage_outputs SELECT ?,stage,output_json,completed_at FROM stage_outputs WHERE job_id=?").run(id, old.id);
    })();
    res.status(201).json(mapJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any));
  });
  app.get("/api/chapters/:id/pages", (req, res) => {
    const revision = (db.prepare("SELECT MAX(revision) n FROM pages WHERE chapter_id=?").get(req.params.id) as any)?.n;
    const pages = revision ? db.prepare("SELECT * FROM pages WHERE chapter_id=? AND revision=? ORDER BY page_number").all(req.params.id, revision).map(mapPage) : [];
    res.json({ revision: revision ?? 0, pages });
  });
  app.post("/api/pages/:id/approve", (req, res) => { db.prepare("UPDATE pages SET approved=1 WHERE id=?").run(req.params.id); res.json({ ok: true }); });
  app.put("/api/pages/:id/lettering", (req, res) => { if (!Array.isArray(req.body.lettering)) return res.status(400).json({ error: "lettering must be an array" }); db.prepare("UPDATE pages SET lettering_json=? WHERE id=?").run(JSON.stringify(req.body.lettering), req.params.id); res.json({ ok: true, artworkRegenerated: false }); });
  app.put("/api/progress", (req, res) => { db.prepare("INSERT INTO reading_progress VALUES(?,?,?,?,?) ON CONFLICT(series_id,chapter_id) DO UPDATE SET page_number=excluded.page_number, scroll_offset=excluded.scroll_offset, updated_at=excluded.updated_at").run(req.body.seriesId, req.body.chapterId, Number(req.body.pageNumber ?? 1), Number(req.body.scrollOffset ?? 0), now()); db.prepare("UPDATE series SET reading_chapter_id=? WHERE id=?").run(req.body.chapterId, req.body.seriesId); res.json({ ok: true }); });
  app.post("/api/chapters/:id/next", (req, res) => {
    const current = db.prepare("SELECT * FROM chapters WHERE id=?").get(req.params.id) as any;
    if (!current) return res.status(404).json({ error: "Chapter not found." });
    const next = db.prepare("SELECT * FROM chapters WHERE series_id=? AND sort_order>? ORDER BY sort_order LIMIT 1").get(current.series_id, current.sort_order) as any;
    if (!next) return res.status(409).json({ code: "source_missing", error: "The next novel chapter has not been imported. Import it to continue." });
    if (next.status === "completed") return res.json({ state: "completed", chapterId: next.id });
    const active = db.prepare("SELECT * FROM jobs WHERE chapter_id=? AND status IN ('queued','running','cancel_requested','uncertain') ORDER BY created_at DESC LIMIT 1").get(next.id) as any;
    if (active) return res.json({ state: active.status, chapterId: next.id, job: mapJob(active) });
    res.json({ state: "not_started", chapterId: next.id });
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({ error: err?.message ?? "Unexpected server error" }));
  return app;
}

function mapChapter(r: any) { return { id: r.id, seriesId: r.series_id, identifier: r.identifier, title: r.title, sortOrder: r.sort_order, sourceText: r.source_text, sourceKind: r.source_kind, sourceMetadata: json(r.source_metadata_json, {}), mappingNote: r.mapping_note, status: r.status }; }
function mapReference(r: any) { return { id: r.id, seriesId: r.series_id, filename: r.filename, filePath: `/files/references/${r.series_id}/${path.basename(r.file_path)}`, mimeType: r.mime_type, tags: json(r.tags_json, []), sourceUrl: r.source_url, chapterLabel: r.chapter_label, maxReferenceChapter: r.max_reference_chapter }; }
function mapJob(r: any) { return { id: r.id, seriesId: r.series_id, chapterId: r.chapter_id, status: r.status, stage: r.stage, completedPages: r.completed_pages, totalPages: r.total_pages, mode: r.mode, pageMin: r.page_min, pageMax: r.page_max, sampleOnly: Boolean(r.sample_only), providerMode: r.provider_mode, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }; }
function mapPage(r: any) { const parts = path.normalize(r.image_path).split(path.sep); const i = parts.lastIndexOf("generated"); return { id: r.id, chapterId: r.chapter_id, revision: r.revision, pageNumber: r.page_number, imagePath: `/files/${parts.slice(i).join("/")}`, layout: json(r.layout_json, []), lettering: json(r.lettering_json, []), approved: Boolean(r.approved) }; }
function detectChapters(text: string) {
  const header = /^(?:chapter|ch\.?|book|part)\s+([^\r\n:—-]+)(?:\s*[:—-]\s*(.*))?$/gim;
  const matches = [...text.matchAll(header)];
  if (!matches.length) return [{ identifier: "1", title: "Chapter 1", sourceText: text.trim(), mappingNote: "" }];
  return matches.map((m, i) => ({ identifier: m[1].trim(), title: (m[2]?.trim() || m[0].trim()), sourceText: text.slice((m.index ?? 0) + m[0].length, matches[i + 1]?.index ?? text.length).trim(), mappingNote: "" }));
}
async function discoverImages(raw: string) {
  let url: URL; try { url = new URL(raw); } catch { throw new Error("Enter a valid HTTP or HTTPS URL."); }
  for (let redirects = 0; redirects < 4; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "NovelToManga/0.1 personal-reference-discovery" }, signal: AbortSignal.timeout(10_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); if (!location) throw new Error("Redirect had no destination."); url = new URL(location, url); continue; }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("The URL did not return an HTML page.");
    const html = (await response.text()).slice(0, 2_000_000);
    const images = [...html.matchAll(/<(?:img|source)[^>]+(?:src|data-src)=["']([^"']+)["']/gi)].map(m => { try { return new URL(m[1], url).href; } catch { return ""; } }).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 40);
    return { sourceUrl: url.href, images, note: images.length ? "Select and upload only references you are permitted to use. Discovery does not download them." : "No directly accessible images were discovered. Use file uploads instead." };
  }
  throw new Error("Too many redirects.");
}
async function fetchPublic(raw: string) {
  let url = new URL(raw);
  for (let redirects = 0; redirects < 4; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "NovelToManga/0.1 personal-reference-import" }, signal: AbortSignal.timeout(10_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); if (!location) throw new Error("Redirect had no destination."); url = new URL(location, url); continue; }
    if (!response.ok) throw new Error(`Image source returned HTTP ${response.status}.`);
    return response;
  }
  throw new Error("Too many redirects.");
}
async function assertPublicUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only unauthenticated HTTP/HTTPS URLs are supported.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => isPrivate(a.address))) throw new Error("Private or internal network destinations are blocked.");
}
function isPrivate(ip: string) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const normalized = ip.toLowerCase(); return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized === "::";
}
