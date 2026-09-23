import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

const TIME_BUFFER_MS = 5 * 60 * 1000; // 5 minutes slack on both ends

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function isGitRepo(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Correlates a session's time window with git activity in `cwd`.
 * Returns null if `cwd` is not a git repository (not an error condition).
 */
export function correlateGitActivity(cwd, startTime, endTime) {
  if (!cwd || !isGitRepo(cwd)) return null;

  const since = new Date((startTime?.getTime() ?? Date.now()) - TIME_BUFFER_MS).toISOString();
  const until = new Date((endTime?.getTime() ?? Date.now()) + TIME_BUFFER_MS).toISOString();

  let repoName = null;
  try {
    const remote = git(cwd, ["config", "--get", "remote.origin.url"]).trim();
    repoName = remote || null;
  } catch {
    // no remote configured; fall back to directory name below
  }
  if (!repoName) {
    repoName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  }

  let commits = [];
  try {
    const log = git(cwd, [
      "log",
      `--since=${since}`,
      `--until=${until}`,
      "--pretty=format:%H%x1f%ad%x1f%s",
      "--date=iso-strict",
      "--stat",
    ]);
    commits = log.trim();
  } catch (err) {
    logger.warn("git log failed", { error: err.message, cwd });
    commits = "";
  }

  let uncommittedDiff = "";
  try {
    uncommittedDiff = git(cwd, ["diff", "HEAD"]);
  } catch (err) {
    logger.warn("git diff failed", { error: err.message, cwd });
  }

  return { repoName, commitLog: redactSecrets(commits), uncommittedDiff: redactSecrets(uncommittedDiff) };
}
