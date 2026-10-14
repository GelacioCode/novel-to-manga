import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { config } from "./config";
import { createAdaptation, generatePanelImage, type ProviderContext } from "./providers";
import { mockSvg } from "./mock";
import { adaptationSchema, type Adaptation } from "./schemas";
import { fitLetteringToPage } from "../shared/lettering";

const stages = ["validate", "extract_and_script", "plan_pages", "generate_artwork", "letter_and_validate", "save_chapter"] as const;

export async function processNextJob(db: Db): Promise<string | null> {
  const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as any;
  if (!job) return null;
  const claimed = db.prepare("UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now(), job.id);
  if (!claimed.changes) return null;
  try { await processJob(db, { ...job, status: "running" }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ambiguous = /timeout|timed out|ECONNRESET|socket hang up/i.test(message) && getJob(db, job.id)?.stage === "provider_request";
    db.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run(ambiguous ? "uncertain" : "failed", message, now(), job.id);
  }
  return job.id;
}

async function processJob(db: Db, job: any) {
  const chapter = db.prepare("SELECT * FROM chapters WHERE id=?").get(job.chapter_id) as any;
  if (!chapter?.source_text.trim()) throw new Error("Source chapter is missing.");
  const guide = db.prepare("SELECT * FROM visual_guides WHERE series_id=? AND approved=1 ORDER BY version DESC LIMIT 1").get(job.series_id) as any;
  if (!guide) throw new Error("Approve a visual guide before generation.");
  const previousContinuity = db.prepare(`SELECT c.snapshot_json FROM continuity c JOIN chapters ch ON ch.id=c.chapter_id WHERE c.series_id=? AND ch.sort_order < ? AND c.invalidated=0 ORDER BY ch.sort_order DESC, c.version DESC LIMIT 1`).get(job.series_id, chapter.sort_order) as any;
  const refs = db.prepare("SELECT file_path FROM reference_images WHERE series_id=?").all(job.series_id) as any[];
  const totalPages = job.sample_only ? 1 : job.total_pages;
  const ctx: ProviderContext = { sourceText: chapter.source_text, mode: job.mode, totalPages, visualGuide: guide.content, continuity: previousContinuity ? JSON.parse(previousContinuity.snapshot_json) : {}, referencePaths: refs.map(r => r.file_path), paidCallsAuthorized: Boolean(job.paid_calls_authorized), db };

  await checkpoint(db, job.id, "validate", { sourceChapterId: chapter.id, guideVersion: guide.version, priorContinuityOnly: true });
  if (cancelled(db, job.id)) return markCancelled(db, job.id);

  let adaptation: Adaptation | null = loadReusableAdaptation(db, job.id);
  if (!adaptation) {
    db.prepare("UPDATE jobs SET stage='provider_request', updated_at=? WHERE id=?").run(now(), job.id);
    const result = await createAdaptation(job.provider_mode, ctx);
    adaptation = adaptationSchema.parse(result.adaptation);
    await checkpoint(db, job.id, "extract_and_script", { adaptation, usage: result.usage, responseId: result.responseId });
  } else await checkpoint(db, job.id, "extract_and_script", { adaptation, reused: true });
  if (cancelled(db, job.id)) return markCancelled(db, job.id);
  await checkpoint(db, job.id, "plan_pages", { pages: adaptation.pages, sourcePassageIds: adaptation.passages.map(p => p.id) });

  const revision = chooseRevision(db, chapter.id, Boolean(job.sample_only));
  const useMockArtwork = job.image_provider_mode === "mock" || (!job.image_provider_mode && job.provider_mode === "mock");
  fs.mkdirSync(path.join(config.dataDir, "generated", chapter.id, String(revision)), { recursive: true });
  for (let i = 0; i < totalPages; i++) {
    if (cancelled(db, job.id)) return markCancelled(db, job.id);
    const pageNumber = i + 1;
    const existing = db.prepare("SELECT * FROM pages WHERE chapter_id=? AND revision=? AND page_number=?").get(chapter.id, revision, pageNumber);
    if (existing) { updateProgress(db, job.id, pageNumber, totalPages); continue; }
    const pagePlan = adaptation.pages[i] ?? adaptation.pages.at(-1)!;
    const panel = pagePlan.panels[0];
    const ext = useMockArtwork ? "svg" : "png";
    const output = path.join(config.dataDir, "generated", chapter.id, String(revision), `page-${pageNumber}.${ext}`);
    if (useMockArtwork) fs.writeFileSync(output, mockSvg(chapter.title, pageNumber, panel.description));
    else {
      db.prepare("UPDATE jobs SET stage='provider_request', updated_at=? WHERE id=?").run(now(), job.id);
      const generated = await generatePanelImage(job.provider_mode, ctx, panel.description);
      fs.writeFileSync(output, generated.bytes);
    }
    const panelId = randomUUID();
    const layout = [{ id: panelId, x: 4, y: 3, width: 92, height: 94, sourcePassageIds: panel.sourcePassageIds }];
    const lettering = fitLetteringToPage(panel.dialogue.map(d => ({ id: randomUUID(), panelId, kind: "dialogue", speaker: d.speaker, text: d.text, x: 0, y: 0, width: 0, height: 0 })), true);
    db.prepare("INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), chapter.id, revision, pageNumber, output, JSON.stringify(layout), JSON.stringify(lettering), 0, now());
    updateProgress(db, job.id, pageNumber, totalPages);
  }
  await checkpoint(db, job.id, "generate_artwork", { revision, pages: totalPages, provider: useMockArtwork ? "mock" : "openai" });
  await checkpoint(db, job.id, "letter_and_validate", { editableLettering: true, artworkUnchanged: true });
  if (!job.sample_only) {
    db.prepare("UPDATE chapters SET status='completed' WHERE id=?").run(chapter.id);
    db.prepare("INSERT INTO continuity VALUES(?,?,?,?,?,?,?)").run(randomUUID(), job.series_id, chapter.id, nextContinuityVersion(db, chapter.id), JSON.stringify({ chapterId: chapter.id, changes: adaptation.continuityChanges, characters: adaptation.characters, locations: adaptation.locations }), 0, now());
  }
  await checkpoint(db, job.id, "save_chapter", { completed: true, sampleOnly: Boolean(job.sample_only) });
  db.prepare("UPDATE jobs SET status='completed', stage='completed', completed_pages=?, updated_at=? WHERE id=?").run(totalPages, now(), job.id);
}

async function checkpoint(db: Db, jobId: string, stage: string, output: unknown) {
  db.prepare("INSERT OR REPLACE INTO stage_outputs VALUES(?,?,?,?)").run(jobId, stage, JSON.stringify(output), now());
  db.prepare("UPDATE jobs SET stage=?, updated_at=? WHERE id=?").run(stage, now(), jobId);
}
function getJob(db: Db, id: string) { return db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any; }
function cancelled(db: Db, id: string) { return Boolean(getJob(db, id)?.cancel_requested); }
function markCancelled(db: Db, id: string) { db.prepare("UPDATE jobs SET status='cancelled', stage='cancelled', updated_at=? WHERE id=?").run(now(), id); }
function updateProgress(db: Db, id: string, pages: number, total: number) { db.prepare("UPDATE jobs SET stage='generate_artwork', completed_pages=?, total_pages=?, updated_at=? WHERE id=?").run(pages, total, now(), id); }
function now() { return new Date().toISOString(); }
function nextContinuityVersion(db: Db, chapterId: string) { return ((db.prepare("SELECT MAX(version) n FROM continuity WHERE chapter_id=?").get(chapterId) as any)?.n ?? 0) + 1; }
function chooseRevision(db: Db, chapterId: string, sampleOnly: boolean) {
  const row = db.prepare("SELECT MAX(revision) n FROM pages WHERE chapter_id=?").get(chapterId) as any;
  if (!row?.n) return 1;
  if (!sampleOnly) {
    const approvedSample = db.prepare("SELECT 1 FROM pages WHERE chapter_id=? AND revision=? AND page_number=1 AND approved=1").get(chapterId, row.n);
    if (approvedSample) return row.n;
  }
  return row.n + 1;
}
function loadReusableAdaptation(db: Db, jobId: string) {
  const own = db.prepare("SELECT output_json FROM stage_outputs WHERE job_id=? AND stage='extract_and_script'").get(jobId) as any;
  if (own) return JSON.parse(own.output_json).adaptation;
  return null;
}
