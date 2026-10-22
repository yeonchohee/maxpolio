import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadConfig } from "./lib/config.js";
import { loadState, saveState } from "./lib/state-store.js";
import { logger } from "./lib/logger.js";

// Free-form categories the model used to invent, mapped onto the fixed list.
const CATEGORY_MAP = {
  "APS/ACC 연동": "Backend",
  "JPA 엔티티 매핑": "Backend",
  "세션/인증 설정": "Backend",
  "CI/CD 배포": "DevOps",
  "대시보드 프론트엔드": "Frontend",
  "재고조사 도구": "Frontend",
  "RAG 검색 품질": "AI·LLM",
  "워크비 RAG 설계": "AI·LLM",
  "개발 자동화 도구": "개발 생산성",
};

const SKIP_DIRS = new Set(["journal", "blog", "reports"]);

// Splits a note into its frontmatter (parsed without date conversion, so
// dates are written back unchanged) and the raw text after it.
function splitNote(raw) {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return null;
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return null;
  try {
    const frontmatter = yaml.load(raw.slice(4, end), { schema: yaml.CORE_SCHEMA });
    if (!frontmatter || typeof frontmatter !== "object") return null;
    const bodyStart = raw.indexOf("\n", end + 1);
    return { frontmatter, rest: bodyStart === -1 ? "" : raw.slice(bodyStart + 1) };
  } catch {
    return null;
  }
}

function planMoves(config) {
  const allowed = new Set(config.categories.map((c) => c.name));
  const moves = [];
  const skipped = [];
  const targets = new Set();

  for (const dir of fs.readdirSync(config.outputDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith(".") || SKIP_DIRS.has(dir.name)) continue;
    const dirPath = path.join(config.outputDir, dir.name);

    for (const file of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file.name);
      const note = splitNote(fs.readFileSync(filePath, "utf8"));
      const oldCategory = note?.frontmatter.category;
      if (!oldCategory) continue; // not a journal note (e.g. hand-written docs)

      const newCategory = allowed.has(oldCategory) ? oldCategory : CATEGORY_MAP[oldCategory];
      if (!newCategory) {
        skipped.push({ file: path.relative(config.outputDir, filePath), reason: `매핑 없는 카테고리 "${oldCategory}"` });
        continue;
      }

      const target = path.join(config.journalDir, newCategory, file.name);
      if (targets.has(target.toLowerCase()) || fs.existsSync(target)) {
        skipped.push({ file: path.relative(config.outputDir, filePath), reason: "같은 이름 파일이 이미 있음" });
        continue;
      }
      targets.add(target.toLowerCase());
      moves.push({ filePath, target, note, from: oldCategory, to: newCategory, name: file.name, dirPath });
    }
  }
  return { moves, skipped };
}

function moveNote({ filePath, target, note, from, to }) {
  const fm = { ...note.frontmatter, category: to };
  // The old category was usually a project name - keep it as a tag.
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  if (from !== to && !tags.some((t) => String(t).toLowerCase() === from.toLowerCase())) {
    fm.tags = [...tags, from];
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const frontmatter = yaml.dump(fm, { lineWidth: -1 });
  fs.writeFileSync(target, `---\n${frontmatter}---\n${note.rest}`, "utf8");
  fs.unlinkSync(filePath);
}

// Points state.json at the moved files, so a re-run of a session replaces
// its note in the new location instead of leaving the old one behind.
function updateState(moves) {
  const key = (p) => path.normalize(p).toLowerCase();
  const byOld = new Map(moves.map((m) => [key(m.filePath), m]));
  const remap = (p) => (p && byOld.get(key(p))?.target) ?? p;

  const state = loadState();
  for (const entry of Object.values(state.sessions)) {
    if (!entry.filePath) continue;
    const moved = byOld.get(key(entry.filePath));
    entry.filePath = remap(entry.filePath);
    entry.partFilePaths = (entry.partFilePaths ?? []).map(remap);
    if (moved) entry.category = moved.to;
  }
  saveState(state);
}

/**
 * One-time move of notes from the old free-form category folders into
 * `journal/<fixed category>/`. Without `apply` it only reports the plan.
 */
export function migrateJournal({ apply }) {
  const config = loadConfig();
  const { moves, skipped } = planMoves(config);
  const removedDirs = [];

  if (apply) {
    for (const m of moves) moveNote(m);
    updateState(moves);
    for (const dirPath of new Set(moves.map((m) => m.dirPath))) {
      try {
        fs.rmdirSync(dirPath); // only succeeds when the folder is now empty
        removedDirs.push(path.basename(dirPath));
      } catch {
        // Still holds files that weren't journal notes.
      }
    }
    logger.info("journal migrated", { moved: moves.length, skipped: skipped.length });
  }

  return {
    moves: moves.map(({ from, to, name }) => ({ from, to, name })),
    skipped,
    removedDirs,
  };
}
