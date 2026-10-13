import fs from "node:fs";
import { MAXPOLIO_HOME, STATE_PATH } from "./paths.js";
import { logger } from "./logger.js";

/**
 * Tracks which sessions have been journaled and at what transcript size, so
 * `maxpolio sync` only re-runs a session when its transcript has grown.
 * `since` is the cutoff for the transcript scan: sessions last touched
 * before it are never picked up (avoids journaling the entire history the
 * first time sync runs).
 */
export function loadState() {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  if (fs.existsSync(STATE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      return { since: data.since ?? new Date().toISOString(), sessions: data.sessions ?? {} };
    } catch (err) {
      logger.error("failed to parse state.json, starting fresh", { error: err });
    }
  }
  const state = { since: new Date().toISOString(), sessions: {} };
  saveState(state);
  return state;
}

export function saveState(state) {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
