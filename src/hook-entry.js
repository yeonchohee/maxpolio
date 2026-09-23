import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.js");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
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

  const child = spawn(
    process.execPath,
    [WORKER_PATH, sessionId, transcriptPath, cwd ?? ""],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

// This script must never block session exit: it does only synchronous,
// fast work (read stdin, spawn a detached child) and returns immediately.
// All slow work (API calls, file I/O) happens in worker.js, independently
// of whether this process or the parent Claude Code session is still alive.
try {
  main();
} catch (err) {
  logger.error("hook-entry: unexpected error", { error: err });
}
process.exit(0);
