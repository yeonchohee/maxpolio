import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadJournalNotes, toDateStr } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { loadProjects } from "../lib/projects-store.js";
import { generateStructured } from "../lib/claude-cli.js";
import { logger } from "../lib/logger.js";

const MAX_INPUT_CHARS = 100000;
const MAX_PORTFOLIO_CHARS = 30000;
const EVIDENCE = /\s*\{\{(n\d+)\}\}/g;

const SCHEMA = {
  type: "object",
  properties: {
    section: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note_id: { type: "string" },
          why: { type: "string" },
          bullet: { type: "string" },
        },
        required: ["note_id", "why", "bullet"],
        additionalProperties: false,
      },
    },
  },
  required: ["section", "candidates"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `너는 개발자 포트폴리오 편집자다. 한 프로젝트의 개발 저널 글들과 작성자의 현재 포트폴리오를 받아서,
(1) 그 프로젝트의 포트폴리오 섹션 초안과 (2) 현재 포트폴리오에 아직 없는 업데이트 후보를 만든다.
반드시 주어진 JSON 스키마로만 응답한다.

section (포트폴리오 섹션 초안):
- 현재 포트폴리오의 형식과 문체(합니다체, 담백하고 짧은 문장)를 그대로 따른다:
  "## 프로젝트 이름" → "> [!summary] 요약" 콜아웃(문제 / 한 일 / 결과 / 역할 · 기간 / 기술) → 한 문단 소개 →
  대표 사례마다 "### 사례 제목"과 "- 문제: / - 판단: / - 한 일: / - 결과:" 항목.
- 현재 포트폴리오에 이 프로젝트 섹션이 이미 있으면 같은 프로젝트 이름을 쓰고, 기존 섹션의 좋은 사례는
  유지하되 저널에서 확인되는 더 강한 사례가 있으면 바꾸거나 더한다. 기존 섹션에만 있고 저널에 근거가 없는
  내용은 그대로 둬도 된다 (작성자가 직접 확인한 내용이다).
- 대표 사례는 3~5개. 채용 담당자가 "이 사람은 문제를 이렇게 푸는구나"를 알 수 있는 것 위주로 고른다:
  설계 판단과 트레이드오프, 원인을 파고든 디버깅, 운영 문제 해결. MR 작성이나 보고서 같은 단순 업무는 뺀다.
- 저널 글에 근거한 문장 끝에는 근거 글의 id를 {{n3}}처럼 붙인다 (여러 개면 {{n3}}{{n7}}). 이 표시는 나중에
  원본 링크로 바뀐다. 저널에 없는 수치나 결과는 절대 지어내지 마라. 근거가 없는 "결과:" 항목은 빼라.
- 기간은 입력의 기간을 참고하되 현재 포트폴리오에 적힌 기간이 있으면 그걸 따른다.

candidates (업데이트 후보):
- 현재 포트폴리오에 아직 반영되지 않은 저널 글 중, 포트폴리오에 넣을 가치가 있는 것. 특히 포트폴리오 기준일
  이후의 글을 우선 본다. 가치 없는 글은 넣지 마라. 없으면 빈 배열.
- why: 왜 넣을 만한지 한 문장. bullet: 포트폴리오에 바로 붙일 수 있는 "- 한 일: ..." 형태의 한 줄.`;

function noteId(i) {
  return `n${i + 1}`;
}

function titleOf(note) {
  return note.frontmatter.title ?? path.basename(note.filePath, ".md");
}

function linkTo(config, filePath, label) {
  const rel = path.relative(config.outputDir, filePath).split(path.sep).join("/").replace(/\.md$/, "");
  return `[[${rel}|${label}]]`;
}

function buildInput({ project, notes, portfolio, baseDate }) {
  const dates = notes.map((n) => toDateStr(n.frontmatter.date)).filter(Boolean).sort();
  const perNote = Math.floor(MAX_INPUT_CHARS / Math.max(notes.length, 1));
  const blocks = notes.map((note, i) => {
    const body = note.body.length > perNote ? `${note.body.slice(0, perNote)}\n...(이하 생략)` : note.body;
    return `### ${noteId(i)} | ${toDateStr(note.frontmatter.date) ?? "날짜 없음"} | ${note.frontmatter.category ?? "-"} | ${titleOf(note)}\n${body}`;
  });

  return [
    `프로젝트: ${project.name}`,
    project.description ? `설명: ${project.description}` : null,
    `저널 기간: ${dates[0] ?? "-"} ~ ${dates[dates.length - 1] ?? "-"}`,
    `포트폴리오 기준일: ${baseDate ?? "알 수 없음"}`,
    "",
    "--- 현재 포트폴리오 ---",
    portfolio ? portfolio.slice(0, MAX_PORTFOLIO_CHARS) : "(없음)",
    "",
    "--- 저널 글 ---",
    ...blocks,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function readPortfolio(config) {
  const filePath = path.join(config.outputDir, config.portfolioPath);
  if (!fs.existsSync(filePath)) return { text: null, baseDate: null, filePath };
  const text = fs.readFileSync(filePath, "utf8");
  return { text, baseDate: text.match(/(\d{4}-\d{2}-\d{2})\s*기준/)?.[1] ?? null, filePath };
}

/**
 * Lists projects that have journal notes, with their note counts.
 */
export function listPortfolioProjects() {
  const config = loadConfig();
  const counts = new Map();
  for (const note of loadJournalNotes(config.journalDir)) {
    const name = note.frontmatter.project;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/**
 * Drafts the portfolio section for one project (matched by name substring)
 * from its journal notes, in the same format as the hand-written portfolio,
 * with each claim linked to the journal note it came from. Also lists notes
 * the current portfolio doesn't cover yet. One `claude -p` call; writes
 * `portfolio/<project>.md`. Returns null if no project matched.
 */
export function generatePortfolioDraft(query) {
  const config = loadConfig();
  const needle = query.toLowerCase();
  const matches = listPortfolioProjects().filter((p) => p.name.toLowerCase().includes(needle));
  if (matches.length === 0) return null;
  if (matches.length > 1 && !matches.some((p) => p.name.toLowerCase() === needle)) {
    return { ambiguous: matches.map((p) => p.name) };
  }
  const name = (matches.find((p) => p.name.toLowerCase() === needle) ?? matches[0]).name;
  const project = loadProjects().find((p) => p.name === name) ?? { name };

  const notes = loadJournalNotes(config.journalDir)
    .filter((n) => n.frontmatter.project === name)
    .sort((a, b) => (toDateStr(a.frontmatter.date) ?? "").localeCompare(toDateStr(b.frontmatter.date) ?? ""));
  const portfolio = readPortfolio(config);

  const out = generateStructured({
    systemPrompt: SYSTEM_PROMPT,
    input: buildInput({ project, notes, portfolio: portfolio.text, baseDate: portfolio.baseDate }),
    jsonSchema: SCHEMA,
    model: config.model,
  });

  const byId = new Map(notes.map((n, i) => [noteId(i), n]));
  const evidence = (id) => (byId.has(id) ? ` (${linkTo(config, byId.get(id).filePath, "근거")})` : "");
  const section = out.section.replace(EVIDENCE, (_, id) => evidence(id)).trim();

  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = { title: `포트폴리오 초안 - ${name}`, project: name, date: today, base_portfolio: portfolio.baseDate ?? "-" };
  const lines = [
    `> maxpolio가 저널 ${notes.length}개로 만든 초안이야. 필요한 부분만 \`${config.portfolioPath}\`에 옮기고, 옮길 때 (근거) 링크는 지워줘.`,
    "",
    section,
    "",
    "---",
    "",
    `## 업데이트 후보 (현재 포트폴리오${portfolio.baseDate ? ` ${portfolio.baseDate} 기준` : ""}에 없는 것)`,
    "",
  ];
  const candidates = out.candidates.filter((c) => byId.has(c.note_id));
  if (candidates.length === 0) lines.push("새로 넣을 만한 글이 없어.");
  for (const c of candidates) {
    const note = byId.get(c.note_id);
    // The candidate's own note is already linked on the line above.
    const bullet = c.bullet.replace(EVIDENCE, "").trim();
    lines.push(`- ${linkTo(config, note.filePath, titleOf(note))} (${toDateStr(note.frontmatter.date) ?? "-"})`, `  - 이유: ${c.why}`, `  - 문장 예: ${bullet}`);
  }

  const dir = path.join(config.outputDir, "portfolio");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.md`);
  fs.writeFileSync(filePath, `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n\n${lines.join("\n")}\n`, "utf8");

  logger.info("portfolio draft saved", { project: name, filePath, noteCount: notes.length, candidates: candidates.length });
  return { name, filePath, noteCount: notes.length, candidateCount: candidates.length };
}
