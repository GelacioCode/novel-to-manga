import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDb, type Db } from "../server/db";
import { createApp } from "../server/app";
import { config } from "../server/config";
import { processNextJob } from "../server/worker-core";
import { getChatGPTStatus, startChatGPTAuthorization } from "../server/chatgpt-auth";

let db: Db; let server: Server; let base: string; let temp: string;

beforeEach(async () => {
  temp = path.join(process.cwd(), ".test-tmp", randomUUID());
  fs.mkdirSync(temp, { recursive: true });
  config.dataDir = temp;
  config.providerMode = "mock";
  db = createDb(path.join(temp, "test.sqlite"));
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });

async function request(url: string, body?: unknown, method = "POST") {
  const response = await fetch(base + url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function seed(twoChapters = false) {
  const series = (await request("/api/series", { title: "Test series" })).data;
  const chapters = [{ identifier: "I", title: "Arrival", sourceText: "Ari entered the silent city.\n\nA bell rang at dusk.", mappingNote: "Manga chapter 1" }];
  if (twoChapters) chapters.push({ identifier: "II-A", title: "Tomorrow", sourceText: "FUTURE_SECRET appears only tomorrow.", mappingNote: "Manga chapter 2" });
  const imported = (await request(`/api/series/${series.id}/chapters`, { chapters })).data;
  await request(`/api/series/${series.id}/guide`, { content: "Approved black-and-white mock guide", approved: true }, "PUT");
  return { seriesId: series.id as string, chapterIds: imported.ids as string[] };
}

describe("persisted mock workflow", () => {
  it("creates a PKCE ChatGPT-plan authorization without exposing credentials", () => {
    const authorization = new URL(startChatGPTAuthorization(db));
    expect(authorization.origin).toBe("https://auth.openai.com");
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorization.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect((db.prepare("SELECT COUNT(*) n FROM chatgpt_oauth_attempts").get() as any).n).toBe(1);
    expect(getChatGPTStatus(db).connected).toBe(false);
  });
  it("deduplicates concurrent generation clicks at the database boundary", async () => {
    const { chapterIds } = await seed();
    const payload = { chapterId: chapterIds[0], mode: "faithful", pageMin: 2, pageMax: 4, sampleOnly: true, paidCallsAuthorized: false };
    const results = await Promise.all(Array.from({ length: 6 }, () => request("/api/jobs", payload)));
    expect(new Set(results.map(r => r.data.id)).size).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n).toBe(1);
  });

  it("runs end to end in mock mode and reopens a completed chapter without a new job", async () => {
    const { chapterIds } = await seed();
    const created = await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 2, pageMax: 3, sampleOnly: false, paidCallsAuthorized: false });
    await processNextJob(db);
    const job = (await request(`/api/jobs/${created.data.id}`, undefined, "GET")).data;
    expect(job.status).toBe("completed"); expect(job.completedPages).toBe(2);
    const pages = (await request(`/api/chapters/${chapterIds[0]}/pages`, undefined, "GET")).data.pages;
    expect(pages).toHaveLength(2); expect(fs.readFileSync(path.join(temp, "generated", chapterIds[0], "1", "page-1.svg"), "utf8")).toContain("MOCK ARTWORK");
    const reopened = await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 2, pageMax: 3, sampleOnly: false, paidCallsAuthorized: false });
    expect(reopened.data.state).toBe("completed"); expect((db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n).toBe(1);
  });

  it("keeps future chapter text out of the current adaptation", async () => {
    const { chapterIds } = await seed(true);
    const created = await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 1, pageMax: 2, sampleOnly: false, paidCallsAuthorized: false });
    await processNextJob(db);
    const output = (db.prepare("SELECT output_json FROM stage_outputs WHERE job_id=? AND stage='extract_and_script'").get(created.data.id) as any).output_json;
    expect(output).not.toContain("FUTURE_SECRET"); expect(output).toContain("silent city");
  });

  it("edits dialogue without touching artwork", async () => {
    const { chapterIds } = await seed();
    await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 1, pageMax: 1, sampleOnly: false, paidCallsAuthorized: false });
    await processNextJob(db);
    const page = (await request(`/api/chapters/${chapterIds[0]}/pages`, undefined, "GET")).data.pages[0];
    const image = path.join(temp, "generated", chapterIds[0], "1", "page-1.svg"); const before = fs.statSync(image).mtimeMs;
    page.lettering[0].text = "Edited locally";
    const result = await request(`/api/pages/${page.id}/lettering`, { lettering: page.lettering }, "PUT");
    expect(result.data.artworkRegenerated).toBe(false); expect(fs.statSync(image).mtimeMs).toBe(before);
  });

  it("reuses an approved sample page while generating the remaining pages", async () => {
    const { chapterIds } = await seed();
    await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 3, pageMax: 4, sampleOnly: true, paidCallsAuthorized: false });
    await processNextJob(db);
    const detail = (await request(`/api/series/${(db.prepare("SELECT series_id FROM chapters WHERE id=?").get(chapterIds[0]) as any).series_id}`, undefined, "GET")).data;
    expect(detail.chapters[0].status).toBe("generating"); expect(detail.chapters[0].pageCount).toBe(1);
    const sample = (await request(`/api/chapters/${chapterIds[0]}/pages`, undefined, "GET")).data.pages[0];
    const image = path.join(temp, "generated", chapterIds[0], "1", "page-1.svg"); const before = fs.statSync(image).mtimeMs;
    await request(`/api/pages/${sample.id}/approve`, {});
    await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 3, pageMax: 4, sampleOnly: false, paidCallsAuthorized: false });
    await processNextJob(db);
    const result = (await request(`/api/chapters/${chapterIds[0]}/pages`, undefined, "GET")).data;
    expect(result.revision).toBe(1); expect(result.pages).toHaveLength(3); expect(result.pages[0].id).toBe(sample.id); expect(fs.statSync(image).mtimeMs).toBe(before);
  });

  it("blocks missing source text and handles queued cancellation", async () => {
    const { seriesId, chapterIds } = await seed();
    const missing = randomUUID(); db.prepare("INSERT INTO chapters VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(missing, seriesId, "missing", "Missing", 2, "", "paste", "{}", "", "imported", new Date().toISOString());
    const blocked = await request("/api/jobs", { chapterId: missing, mode: "faithful", pageMin: 1, pageMax: 1, sampleOnly: true, paidCallsAuthorized: false });
    expect(blocked.status).toBe(409); expect(blocked.data.code).toBe("source_missing");
    const created = await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 1, pageMax: 1, sampleOnly: true, paidCallsAuthorized: false });
    await request(`/api/jobs/${created.data.id}/cancel`, {});
    expect((await request(`/api/jobs/${created.data.id}`, undefined, "GET")).data.status).toBe("cancelled");
  });

  it("recovers a running job after reopening the database and copies checkpoints on retry", async () => {
    const { chapterIds } = await seed();
    const created = await request("/api/jobs", { chapterId: chapterIds[0], mode: "faithful", pageMin: 1, pageMax: 1, sampleOnly: true, paidCallsAuthorized: false });
    db.prepare("UPDATE jobs SET status='running', stage='plan_pages' WHERE id=?").run(created.data.id);
    await new Promise<void>(resolve => server.close(() => resolve())); db.close();
    db = createDb(path.join(temp, "test.sqlite")); server = createApp(db).listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((db.prepare("SELECT status FROM jobs WHERE id=?").get(created.data.id) as any).status).toBe("queued");
    db.prepare("UPDATE jobs SET status='failed', error='test' WHERE id=?").run(created.data.id);
    db.prepare("INSERT INTO stage_outputs VALUES(?,?,?,?)").run(created.data.id, "validate", JSON.stringify({ saved: true }), new Date().toISOString());
    const retried = await request(`/api/jobs/${created.data.id}/retry`, {});
    expect(retried.data.status).toBe("queued");
    expect((db.prepare("SELECT COUNT(*) n FROM stage_outputs WHERE job_id=?").get(retried.data.id) as any).n).toBe(1);
  });
});
