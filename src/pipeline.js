import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { parseTranscript, renderTranscriptLog } from "./lib/transcript-parser.js";
import { correlateGitActivity } from "./lib/git-correlator.js";
import { loadCategories, recordCategoryUsage } from "./lib/categories-store.js";
import { generateJournalEntry } from "./lib/claude-cli.js";
import { saveJournalEntry } from "./lib/journal-store.js";
import { removeFile } from "./lib/remove-file.js";

/**
 * Runs the full journal pipeline for one session: parse -> git correlate ->
 * classify+generate (one combined `claude -p` call) -> save. Used both by
 * `maxpolio sync` and by `maxpolio test-session` for manual debugging.
 * `previous` is the state entry of an earlier run for the same session; its
 * notes are replaced by the new ones. Never throws - every failure is logged
 * and reflected in the returned `status`.
 */
export async function runPipeline({ sessionId, transcriptPath, cwd, previous }) {
  const config = loadConfig();

  let parsed;
  try {
    parsed = parseTranscript(transcriptPath);
  } catch (err) {
    logger.error("failed to parse transcript", { error: err, sessionId, transcriptPath });
    return { status: "error", reason: "parse_failed" };
  }

  const resolvedCwd = cwd || parsed.cwd;
  const gitActivity = correlateGitActivity(resolvedCwd, parsed.startTime, parsed.endTime);
  const sessionLog = renderTranscriptLog(parsed);

  if (!sessionLog.trim()) {
    logger.info("empty session log, skipping", { sessionId });
    return { status: "skipped", reason: "empty_log" };
  }

  const existingCategories = loadCategories();

  let classification, overview, parts;
  try {
    ({ classification, overview, parts } = generateJournalEntry({
      sessionLog,
      gitActivity,
      existingCategories,
      model: config.model,
    }));
  } catch (err) {
    logger.error("journal generation failed", { error: err, sessionId });
    return { status: "error", reason: "generation_failed" };
  }

  logger.info("classified session", { sessionId, classification });

  if (!classification.should_journal) {
    logger.info("session skipped (not journal-worthy)", {
      sessionId,
      reason: classification.should_journal_reason,
    });
    return { status: "skipped", reason: "not_journal_worthy", classification };
  }

  let filePath, partFilePaths;
  try {
    // Removed only now, after generation succeeded, so a failed re-run never
    // costs the note that already exists. Done before saving so an unchanged
    // title reuses its filename instead of getting a " 2" suffix.
    removePreviousNotes(previous);
    ({ filePath, partFilePaths } = saveJournalEntry({
      outputDir: config.outputDir,
      classification,
      overview,
      parts,
      sessionId,
      repo: gitActivity?.repoName,
      date: parsed.endTime ?? new Date(),
    }));
  } catch (err) {
    logger.error("failed to save journal entry", { error: err, sessionId });
    return { status: "error", reason: "save_failed" };
  }

  if (previous?.category !== classification.category) {
    recordCategoryUsage(
      classification.category,
      classification.is_new_category ? classification.category_description : undefined,
    );
  }

  logger.info("journal entry saved", { sessionId, filePath, partFilePaths, category: classification.category });
  return { status: "saved", filePath, partFilePaths, classification };
}

function removePreviousNotes(previous) {
  const paths = [previous?.filePath, ...(previous?.partFilePaths ?? [])].filter(Boolean);
  for (const p of paths) {
    removeFile(p);
  }
  if (paths.length > 0) {
    try {
      // Only succeeds when the category folder is now empty.
      fs.rmdirSync(path.dirname(paths[0]));
    } catch {
      // Still has other notes in it.
    }
  }
}
