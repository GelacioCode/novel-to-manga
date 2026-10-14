import { getDb } from "./db";
import { processNextJob } from "./worker-core";

const db = getDb();
console.log("Novel to Manga worker started");
let active = false;
async function tick() {
  if (active) return;
  active = true;
  try { while (await processNextJob(db)) { /* drain queue */ } }
  catch (error) { console.error("Worker tick failed", error); }
  finally { active = false; }
}
void tick();
setInterval(() => void tick(), 750);
