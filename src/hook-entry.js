import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";
import { QUEUE_DIR, SYNC_TASK_NAME } from "./lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "..", "bin", "maxpolio.js");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Anything spawned from here can be torn down together with the session
// (closing the terminal window killed the old detached worker's `claude -p`
// with SIGHUP), so on Windows the scheduled task is asked to run instead: it
// lives in Task Scheduler's process tree, not ours.
function kickSync() {
  if (process.platform === "win32") {
    const res = spawnSync("schtasks", ["/run", "/tn", SYNC_TASK_NAME], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status === 0) return;
    logger.warn("hook-entry: could not start scheduled task, falling back to detached sync", {
      status: res.status,
      error: res.error?.message,
    });
  }

  const child = spawn(process.execPath, [CLI_PATH, "sync"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    logger.error("hook-entry: failed to parse stdin JSON", { error: err.message, raw: raw.slice(0, 500) });
    return;
  }

  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = payload;

  if (!sessionId || !transcriptPath) {
    logger.warn("hook-entry: missing session_id/transcript_path, skipping", { payload });
    return;
  }

  // The queue entry is what guarantees the session gets journaled: even if
  // kicking the sync fails, the next scheduled run picks it up.
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(QUEUE_DIR, `${sessionId}.json`),
    JSON.stringify({ sessionId, transcriptPath, cwd: cwd ?? "", queuedAt: new Date().toISOString() }) + "\n",
    "utf8",
  );

  kickSync();
}

// This script must never block session exit: it only reads stdin, writes a
// small queue file and pokes the scheduler. All slow work (the `claude -p`
// call, file I/O) happens in `maxpolio sync`.
try {
  main();
} catch (err) {
  logger.error("hook-entry: unexpected error", { error: err });
}
process.exit(0);
