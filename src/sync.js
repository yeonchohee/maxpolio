import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { CLAUDE_PROJECTS_DIR, LOCK_PATH, MAXPOLIO_HOME, QUEUE_DIR } from "./lib/paths.js";
import { removeFile } from "./lib/remove-file.js";
import { loadState, saveState } from "./lib/state-store.js";
import { runPipeline } from "./pipeline.js";

const LOCK_STALE_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

function acquireLock() {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      let ageMs = 0;
      let holderAlive = true;
      try {
        ageMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        // Signal 0 only checks existence; it throws if the holder is gone
        // (killed mid-run without a chance to remove its lock).
        process.kill(Number(fs.readFileSync(LOCK_PATH, "utf8")), 0);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        holderAlive = false;
      }
      if (holderAlive && ageMs < LOCK_STALE_MS) return false;
      removeFile(LOCK_PATH);
    }
  }
  return false;
}

function queuePath(sessionId) {
  return path.join(QUEUE_DIR, `${sessionId}.json`);
}

function readQueue() {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  const items = [];
  for (const name of fs.readdirSync(QUEUE_DIR)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(QUEUE_DIR, name);
    try {
      const item = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (item.sessionId && item.transcriptPath) items.push(item);
      else removeFile(filePath);
    } catch (err) {
      logger.warn("sync: dropping unreadable queue file", { error: err.message, filePath });
      removeFile(filePath);
    }
  }
  return items;
}

function scanTranscripts(sinceMs) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const found = [];
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    for (const name of fs.readdirSync(projectDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const transcriptPath = path.join(projectDir, name);
      try {
        if (fs.statSync(transcriptPath).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      found.push({ sessionId: path.basename(name, ".jsonl"), transcriptPath });
    }
  }
  return found;
}

// Non-interactive `claude -p` runs (including the ones older maxpolio
// versions made for their own generation calls) start with a
// queue-operation line. Journaling those would be journaling ourselves.
function isPrintModeTranscript(transcriptPath) {
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, n).startsWith('{"type":"queue-operation"');
  } finally {
    fs.closeSync(fd);
  }
}

async function syncPass(config, state) {
  const candidates = new Map();
  for (const item of scanTranscripts(new Date(state.since).getTime())) {
    candidates.set(item.sessionId, { ...item, ended: false });
  }
  // Queue entries come from the SessionEnd hook: the session is over, so
  // there's no need to wait for it to go idle.
  for (const item of readQueue()) {
    candidates.set(item.sessionId, { ...item, ended: true });
  }

  const idleMs = config.idleMinutes * 60 * 1000;
  let attempted = 0;

  for (const { sessionId, transcriptPath, cwd, ended } of candidates.values()) {
    const dequeue = () => ended && removeFile(queuePath(sessionId));

    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      // Sessions that never got a message have no transcript file.
      dequeue();
      continue;
    }

    const prev = state.sessions[sessionId];
    if (prev?.size === stat.size) {
      dequeue();
      continue;
    }
    if (prev?.failedSize === stat.size && prev.failCount >= MAX_ATTEMPTS) {
      dequeue();
      continue;
    }
    if (!ended && Date.now() - stat.mtimeMs < idleMs) continue;

    if (isPrintModeTranscript(transcriptPath)) {
      state.sessions[sessionId] = { status: "ignored", size: stat.size };
      saveState(state);
      dequeue();
      continue;
    }

    attempted += 1;
    const result = await runPipeline({ sessionId, transcriptPath, cwd, previous: prev });
    const entry = { ...prev, transcriptPath, processedAt: new Date().toISOString() };

    if (result.status === "error") {
      entry.failCount = prev?.failedSize === stat.size ? (prev.failCount ?? 0) + 1 : 1;
      entry.failedSize = stat.size;
      entry.status ??= "error";
    } else {
      entry.size = stat.size;
      delete entry.failCount;
      delete entry.failedSize;
      if (result.status === "saved") {
        entry.status = "saved";
        entry.filePath = result.filePath;
        entry.partFilePaths = result.partFilePaths;
        entry.category = result.classification.category;
      } else if (!entry.filePath) {
        entry.status = "skipped";
      }
      dequeue();
    }

    state.sessions[sessionId] = entry;
    saveState(state);
  }

  return attempted;
}

/**
 * Journals every session that needs it: ones queued by the SessionEnd hook,
 * plus any transcript that has grown since it was last journaled and has
 * been idle for `idleMinutes` (covers sessions left open for days and runs
 * that died before finishing). Meant to be run by the scheduled task, i.e.
 * outside the process tree of the session that is ending.
 */
export async function runSync() {
  if (!acquireLock()) {
    logger.info("sync: another sync is running, skipping");
    return { status: "locked" };
  }
  try {
    const config = loadConfig();
    const state = loadState();
    let total = 0;
    let attempted;
    // Repeat so sessions that end while a pass is running get picked up too.
    do {
      attempted = await syncPass(config, state);
      total += attempted;
    } while (attempted > 0);
    return { status: "done", attempted: total };
  } finally {
    removeFile(LOCK_PATH);
  }
}
