import fs from "node:fs";
import readline from "node:readline";
import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";

const MAX_BLOCK_CHARS = 4000;

function truncate(str) {
  if (typeof str !== "string") return str;
  const redacted = redactSecrets(str);
  if (redacted.length <= MAX_BLOCK_CHARS) return redacted;
  return redacted.slice(0, MAX_BLOCK_CHARS) + `\n...(truncated, ${redacted.length - MAX_BLOCK_CHARS} more chars)`;
}

function contentToPreview(content) {
  if (typeof content === "string") return truncate(content);
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block?.type === "text") return truncate(block.text ?? "");
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Parses a Claude Code session transcript JSONL file into a compact,
 * defensive representation. The transcript format is internal to Claude
 * Code and can change between versions, so every field access here is
 * optional-chained and unknown line shapes/types are simply skipped
 * (logged, never thrown).
 */
export function parseTranscript(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");

  const turns = [];
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let startTime = null;
  let endTime = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      logger.warn("skipping unparsable transcript line", { error: err.message });
      continue;
    }

    sessionId ??= entry.sessionId ?? entry.session_id ?? null;
    cwd ??= entry.cwd ?? null;
    gitBranch ??= entry.gitBranch ?? null;

    if (entry.timestamp) {
      const t = new Date(entry.timestamp);
      if (!Number.isNaN(t.getTime())) {
        if (!startTime || t < startTime) startTime = t;
        if (!endTime || t > endTime) endTime = t;
      }
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const role = entry.message?.role;
    const content = entry.message?.content;
    if (!role) continue;

    const turn = { role, timestamp: entry.timestamp ?? null, text: "", toolCalls: [] };

    if (typeof content === "string") {
      turn.text = truncate(content);
    } else if (Array.isArray(content)) {
      const textParts = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        switch (block.type) {
          case "text":
            textParts.push(truncate(block.text ?? ""));
            break;
          case "tool_use":
            turn.toolCalls.push({
              kind: "call",
              name: block.name ?? "unknown_tool",
              input: truncate(JSON.stringify(block.input ?? {})),
            });
            break;
          case "tool_result":
            turn.toolCalls.push({
              kind: "result",
              isError: Boolean(block.is_error),
              preview: contentToPreview(block.content),
            });
            break;
          default:
            // thinking blocks and anything else are intentionally skipped
            break;
        }
      }
      turn.text = textParts.join("\n");
    }

    if (turn.text || turn.toolCalls.length > 0) {
      turns.push(turn);
    }
  }

  return { sessionId, cwd, gitBranch, startTime, endTime, turns };
}

/**
 * Renders parsed turns into a compact text log suitable for feeding to
 * an LLM prompt (classification and generation).
 */
export function renderTranscriptLog(parsed) {
  const lines = [];
  for (const turn of parsed.turns) {
    if (turn.role === "user" && turn.text) {
      lines.push(`[USER] ${turn.text}`);
    }
    if (turn.role === "assistant" && turn.text) {
      lines.push(`[ASSISTANT] ${turn.text}`);
    }
    for (const call of turn.toolCalls) {
      if (call.kind === "call") {
        lines.push(`  -> tool_use: ${call.name}(${call.input})`);
      } else {
        lines.push(`  <- tool_result${call.isError ? " (error)" : ""}: ${call.preview}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Caps a rendered log to `maxChars`, keeping the head (problem context)
 * and tail (resolution) and dropping the middle if it's too long.
 */
export function truncateLogMiddle(log, maxChars) {
  if (log.length <= maxChars) return log;
  const half = Math.floor(maxChars / 2);
  const head = log.slice(0, half);
  const tail = log.slice(log.length - half);
  return `${head}\n\n...(middle of session omitted, ${log.length - maxChars} chars)...\n\n${tail}`;
}
