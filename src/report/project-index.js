import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadJournalNotes, toDateStr } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { loadProjects } from "../lib/projects-store.js";
import { logger } from "../lib/logger.js";

const GENERATED_BY = "maxpolio";
const PART_BACKLINK = /^> \[\[([^\]|]+)(?:\|[^\]]*)?\]\]의 일부/;
const TOP_TECH = 10;

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

// Vault-relative wikilink so same-named journal/blog notes never collide.
function linkTo(config, filePath, label) {
  const rel = path.relative(config.outputDir, filePath).split(path.sep).join("/").replace(/\.md$/, "");
  return `[[${rel}|${label.replace(/[|\]]/g, " ")}]]`;
}

function titleOf(note) {
  return note.frontmatter.title ?? path.basename(note.filePath, ".md");
}

function countBy(items) {
  const counts = new Map();
  for (const item of items) if (item) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderIndex(config, project, notes) {
  const isPart = (n) => PART_BACKLINK.test(n.body);
  const mains = notes.filter((n) => !isPart(n));
  const partsOf = (main) =>
    notes.filter((n) => isPart(n) && path.dirname(n.filePath) === path.dirname(main.filePath) && n.body.match(PART_BACKLINK)[1].trim() === path.basename(main.filePath, ".md"));

  const dated = mains
    .map((n) => ({ note: n, date: toDateStr(n.frontmatter.date) ?? "날짜 없음" }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dates = dated.map((d) => d.date).filter((d) => d !== "날짜 없음");
  const period = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "-";

  const frontmatter = {
    title: project.name,
    type: "project",
    period,
    notes: mains.length,
    generated_by: GENERATED_BY,
  };

  const lines = [
    `> maxpolio가 저널을 모아 자동으로 만드는 노트야. 여기 직접 쓴 내용은 다음 sync 때 덮어써져.`,
    "",
  ];
  if (project.description) lines.push(project.description, "");
  lines.push(
    `- **기간**: ${period}`,
    `- **글**: ${mains.length}개 — ${countBy(mains.map((n) => n.frontmatter.category))
      .map(([c, n]) => `${c} ${n}`)
      .join(" · ")}`,
    `- **주요 기술**: ${countBy(notes.flatMap((n) => n.frontmatter.tech_stack ?? []))
      .slice(0, TOP_TECH)
      .map(([t]) => t)
      .join(", ") || "-"}`,
    "",
    "## 타임라인",
  );

  let month = null;
  for (const { note, date } of dated) {
    const m = date.slice(0, 7);
    if (m !== month) {
      lines.push("", `### ${m}`, "");
      month = m;
    }
    const blogPath = path.join(config.blogDir, path.basename(path.dirname(note.filePath)), path.basename(note.filePath));
    const blog = fs.existsSync(blogPath) ? ` · ${linkTo(config, blogPath, "블로그")}` : "";
    lines.push(`- ${date.slice(5)} \`${note.frontmatter.category ?? "-"}\` ${linkTo(config, note.filePath, titleOf(note))}${blog}`);
    for (const part of partsOf(note)) lines.push(`  - 곁가지: ${linkTo(config, part.filePath, titleOf(part))}`);
  }

  return `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n\n${lines.join("\n")}\n`;
}

/**
 * Rewrites `projects/<project>.md` for every project that has journal notes:
 * period, category mix, main tech stack and a dated timeline linking the
 * originals (and blog versions). Index notes this tool made earlier for
 * projects that no longer have notes are removed. No `claude -p` call.
 */
export function generateProjectIndexes() {
  const config = loadConfig();
  const projectsDir = path.join(config.outputDir, "projects");
  const known = new Map(loadProjects().map((p) => [p.name, p]));

  const byProject = new Map();
  for (const note of loadJournalNotes(config.journalDir)) {
    const name = note.frontmatter.project;
    if (!name) continue;
    if (!byProject.has(name)) byProject.set(name, []);
    byProject.get(name).push(note);
  }

  fs.mkdirSync(projectsDir, { recursive: true });
  const written = new Set();
  for (const [name, notes] of byProject) {
    const filePath = path.join(projectsDir, `${safeName(name)}.md`);
    fs.writeFileSync(filePath, renderIndex(config, known.get(name) ?? { name }, notes), "utf8");
    written.add(path.basename(filePath));
  }

  for (const file of fs.readdirSync(projectsDir)) {
    if (!file.endsWith(".md") || written.has(file)) continue;
    const full = path.join(projectsDir, file);
    if (fs.readFileSync(full, "utf8").includes(`generated_by: ${GENERATED_BY}`)) fs.unlinkSync(full);
  }

  logger.info("project indexes written", { count: written.size });
  return [...written];
}
