import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";

// Only the text between these markers is rewritten; the rest of the README
// is hand-written and left alone.
const START = "<!-- maxpolio:categories:start -->";
const END = "<!-- maxpolio:categories:end -->";

// Same folder naming as journal-store.js.
function folderName(name) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "uncategorized";
}

function countNotes(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderSection(config) {
  const categories = config.categories;
  const withExample = categories.some((c) => c.example);
  const header = withExample
    ? ["| 카테고리 | 들어가는 이야기 | 예시 | 노트 수 |", "|---|---|---|---|"]
    : ["| 카테고리 | 들어가는 이야기 | 노트 수 |", "|---|---|---|"];
  const rows = categories.map((c) => {
    const count = countNotes(path.join(config.journalDir, folderName(c.name)));
    const cols = [cell(c.name), cell(c.description), ...(withExample ? [cell(c.example)] : []), count];
    return `| ${cols.join(" | ")} |`;
  });
  return [
    START,
    `> 이 표는 \`~/.maxpolio/config.json\`의 카테고리로 sync 때마다 자동 갱신돼요. 직접 고치지 말고 설정을 바꾸세요.`,
    "",
    `카테고리는 아래 ${categories.length}개로 고정돼 있어요.`,
    "대화가 어느 프로젝트에서 나왔는지, 길었는지 짧았는지가 아니라 **무슨 이야기였는지**로 정해요.",
    "",
    ...header,
    ...rows,
    END,
  ].join("\n");
}

/**
 * Rewrites the category section of `<outputDir>/README.md` from the current
 * config, so the README follows category changes without manual edits.
 * Does nothing if the README or its markers are missing. Returns true when
 * the file changed.
 */
export function updateJournalReadme(config = loadConfig()) {
  const readmePath = path.join(config.outputDir, "README.md");
  if (!fs.existsSync(readmePath)) return false;

  const text = fs.readFileSync(readmePath, "utf8");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    logger.warn("journal README has no category markers, skipping", { readmePath });
    return false;
  }

  const next = text.slice(0, start) + renderSection(config) + text.slice(end + END.length);
  if (next === text) return false;
  fs.writeFileSync(readmePath, next, "utf8");
  return true;
}
