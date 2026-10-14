import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export type Db = Database.Database;

export function createDb(filename = path.join(config.dataDir, "novel-to-manga.sqlite")): Db {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, reading_chapter_id TEXT
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL,
      source_text TEXT NOT NULL, source_kind TEXT NOT NULL DEFAULT 'paste', source_metadata_json TEXT NOT NULL DEFAULT '{}', mapping_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'imported', created_at TEXT NOT NULL,
      UNIQUE(series_id, identifier), UNIQUE(series_id, sort_order)
    );
    CREATE TABLE IF NOT EXISTS reference_images (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT NOT NULL, tags_json TEXT NOT NULL,
      source_url TEXT, chapter_label TEXT, max_reference_chapter TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visual_guides (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      content TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(series_id, version)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      status TEXT NOT NULL, stage TEXT NOT NULL, completed_pages INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL, mode TEXT NOT NULL, page_min INTEGER NOT NULL, page_max INTEGER NOT NULL,
      sample_only INTEGER NOT NULL, provider_mode TEXT NOT NULL, paid_calls_authorized INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, provider_request_id TEXT,
      actual_usage_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_chapter ON jobs(chapter_id)
      WHERE status IN ('queued','running','cancel_requested','uncertain');
    CREATE TABLE IF NOT EXISTS stage_outputs (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      output_json TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY(job_id, stage)
    );
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, page_number INTEGER NOT NULL, image_path TEXT NOT NULL,
      layout_json TEXT NOT NULL, lettering_json TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE(chapter_id, revision, page_number)
    );
    CREATE TABLE IF NOT EXISTS continuity (
      id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE(chapter_id, version)
    );
    CREATE TABLE IF NOT EXISTS reading_progress (
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL DEFAULT 1, scroll_offset REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, PRIMARY KEY(series_id, chapter_id)
    );
  `);
  const chapterColumns = db.prepare("PRAGMA table_info(chapters)").all() as Array<{ name: string }>;
  if (!chapterColumns.some(c => c.name === "source_metadata_json")) db.exec("ALTER TABLE chapters ADD COLUMN source_metadata_json TEXT NOT NULL DEFAULT '{}'");
  // A crashed worker leaves running jobs recoverable at startup.
  db.prepare("UPDATE jobs SET status='queued', stage=CASE WHEN stage='provider_request' THEN 'reconcile' ELSE stage END, updated_at=? WHERE status='running'").run(new Date().toISOString());
  return db;
}

let singleton: Db | undefined;
export function getDb(): Db { return singleton ??= createDb(); }
export function closeDb(): void { singleton?.close(); singleton = undefined; }
