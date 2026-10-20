import fs from "node:fs";
import path from "node:path";
import { loadJournalNotes, toDateStr } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { generateStructured, generateText } from "../lib/claude-cli.js";

// Budget for the notes of one project in a single prompt; each note gets an
// equal share so a project with many notes still fits.
const MAX_PROJECT_CHARS = 100000;
const MAX_SKILLS = 20;

const PROJECT_SCHEMA = {
  type: "object",
  properties: {
    project_title: { type: "string" },
    one_liner: { type: "string" },
    role: { type: "string" },
    achievements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
    },
    wanted_bullets: { type: "array", items: { type: "string" } },
  },
  required: ["project_title", "one_liner", "role", "achievements", "wanted_bullets"],
  additionalProperties: false,
};

const PROJECT_SYSTEM_PROMPT = `너는 개발자의 작업 저널을 이력서 문구로 바꿔주는 도구다. 한 프로젝트에 속한 저널 노트들이 주어지면,
채용 사이트 이력서에 그대로 붙여넣을 수 있는 내용을 주어진 JSON 스키마로만 응답한다.

공통 규칙:
- 저널에 실제로 적힌 내용만 써라. 수치, 성능 개선 폭, 사용자 수, 기간, 팀 규모 등은 저널에 명시된 것만 쓰고
  하나도 지어내지 마라. 근거가 없으면 수치 없이 "무엇을 왜 어떻게 했는지"로 써라.
- 외부에 공개되는 글이다. 내부 호스트명, IP, URL, 계정, 토큰, 고객사·담당자 실명, 내부 브랜치/티켓 번호는
  쓰지 마라. 필요하면 "사내 GitLab", "운영 서버"처럼 일반화해라.
- 저널의 블로그 말투("삽질", "찾았다" 등)는 버리고 이력서 문체로 써라: 명사형/개조식 종결("~구현", "~개선",
  "~해결"), 군더더기 없는 문장. 마크다운 문법(#, **, 백틱, 링크)은 쓰지 마라 — 일반 텍스트 입력란에 붙여넣는다.
- 사소한 작업(MR 메시지 작성, 단순 설정 변경, 문서 정리)은 빼고, 기술적 판단이 드러나는 일을 골라라.
  비슷한 노트 여러 개는 하나의 성과로 묶어라.

필드별 규칙:
- project_title: 사람이 읽는 프로젝트명 (저장소 이름 그대로가 아니라 무엇을 만드는 프로젝트인지 드러나게, 30자 이내).
- one_liner: 프로젝트가 무엇인지 한 문장.
- role: 저널에서 드러나는 담당 영역 (예: "백엔드 API, 프론트엔드 위젯, 배포 파이프라인 구축"). 직급이나 팀 내
  위치는 저널에 없으면 쓰지 마라.
- achievements: 잡코리아 경력기술서용. 3~6개. title은 성과를 한 줄로(40자 이내), detail은 "문제/배경 → 한 일 →
  결과" 흐름으로 2~4문장.
- wanted_bullets: 원티드 "주요 성과"용. 3~5개. 각각 한 줄(80자 이내), 동사로 끝나는 성과 중심 문장. achievements와
  같은 내용을 더 짧게 압축한 것이어야 한다.`;

const INTRO_SYSTEM_PROMPT = `너는 개발자의 프로젝트 요약을 보고 원티드 이력서의 "간단 소개글"을 써주는 도구다. 3~4문장, 일반 텍스트(마크다운
금지), 이력서 문체로 써라. 주어진 요약에 있는 내용만 근거로 하고, 연차·직급·수치 등 요약에 없는 사실은 지어내지 마라.
소개글 본문만 출력해라 (제목, 따옴표, 설명 금지).`;

function repoKeyOf(frontmatter) {
  const repo = frontmatter.repo;
  if (!repo || repo === "unknown") return null;
  return repo
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    .replace(/\.git$/, "");
}

function groupByProject(notes) {
  const projects = new Map();
  const add = (key, note) => {
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(note);
  };

  const orphans = [];
  for (const note of notes) {
    const key = repoKeyOf(note.frontmatter);
    if (key) add(key, note);
    else orphans.push(note);
  }

  // Sessions run outside a git repo have no project to hang on to. If the
  // note names a known repo in its title or tags it belongs there (work on
  // a project done from another directory); otherwise the category is the
  // closest thing to a project.
  const repoKeys = [...projects.keys()];
  for (const note of orphans) {
    const fm = note.frontmatter;
    const haystack = [fm.title ?? path.basename(note.filePath, ".md"), ...(fm.tags ?? [])].join(" ").toLowerCase();
    const repoKey = repoKeys.find((k) => haystack.includes(k.toLowerCase()));
    add(repoKey ?? fm.category ?? "기타", note);
  }
  return projects;
}

function periodOf(notes) {
  const dates = notes
    .map((n) => toDateStr(n.frontmatter.date))
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return null;
  const from = dates[0].slice(0, 7).replace("-", ".");
  const to = dates[dates.length - 1].slice(0, 7).replace("-", ".");
  return from === to ? from : `${from} ~ ${to}`;
}

function topTechStack(notes, limit) {
  const counts = new Map();
  for (const note of notes) {
    for (const tech of note.frontmatter.tech_stack ?? []) {
      counts.set(tech, (counts.get(tech) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tech]) => tech);
}

function buildProjectInput(key, notes) {
  const perNote = Math.floor(MAX_PROJECT_CHARS / notes.length);
  const sorted = [...notes].sort((a, b) =>
    (toDateStr(a.frontmatter.date) ?? "").localeCompare(toDateStr(b.frontmatter.date) ?? ""),
  );
  const blocks = sorted.map((note) => {
    const title = note.frontmatter.title ?? path.basename(note.filePath, ".md");
    const body = note.body.length > perNote ? note.body.slice(0, perNote) + "\n...(이하 생략)" : note.body;
    return `### ${title} (${toDateStr(note.frontmatter.date) ?? "날짜 없음"}, 카테고리: ${note.frontmatter.category ?? "-"})\n${body}`;
  });
  return `프로젝트(저장소): ${key}\n노트 ${notes.length}개\n\n${blocks.join("\n\n")}`;
}

const REVIEW_NOTICE = [
  "> 붙여넣기 전에 꼭 확인:",
  "> - 기간은 저널이 남아 있는 범위일 뿐이야. 실제 참여 기간으로 고쳐 써.",
  "> - 수치·성과는 저널에 적힌 것만 들어가 있어. 아는 수치가 있으면 직접 보강해.",
  "> - 회사 내부 정보(서버, 고객사, 내부 프로젝트명)가 남아 있지 않은지 한 번 훑어봐.",
  "",
].join("\n");

function renderJobkorea(projects, dateStr) {
  const lines = [`# 잡코리아 경력기술서 초안 (${dateStr})`, "", REVIEW_NOTICE];
  lines.push("아래 코드 블록 안의 내용을 잡코리아 이력서 > 경력 > 경력기술서(또는 프로젝트) 입력란에 붙여넣으면 돼.", "");
  for (const p of projects) {
    lines.push(`## ${p.project_title}`, "", "```text");
    lines.push(`[프로젝트] ${p.project_title}`);
    if (p.period) lines.push(`[기간] ${p.period}`);
    lines.push(`[개요] ${p.one_liner}`);
    lines.push(`[담당 역할] ${p.role}`);
    if (p.techStack.length > 0) lines.push(`[사용 기술] ${p.techStack.join(", ")}`);
    lines.push("[주요 업무 및 성과]");
    for (const [i, a] of p.achievements.entries()) {
      lines.push(`${i + 1}. ${a.title}`, `   - ${a.detail}`);
    }
    lines.push("```", "");
  }
  return lines.join("\n");
}

function renderWanted(projects, intro, skills, dateStr) {
  const lines = [`# 원티드 이력서 초안 (${dateStr})`, "", REVIEW_NOTICE];
  lines.push("## 간단 소개글", "", "```text", intro, "```", "");
  lines.push("## 경력 > 주요 성과", "", "회사를 추가한 뒤, 프로젝트별로 '주요 성과' 항목에 하나씩 넣어.", "");
  for (const p of projects) {
    lines.push(`### ${p.project_title}${p.period ? ` (${p.period})` : ""}`, "", "```text");
    lines.push(p.one_liner);
    for (const b of p.wanted_bullets) lines.push(`- ${b}`);
    lines.push("```", "");
  }
  lines.push("## 스킬", "", "원티드 스킬 태그 검색창에 하나씩 입력해 (저널에 많이 등장한 순).", "", "```text", skills.join(", "), "```", "");
  return lines.join("\n");
}

/**
 * Turns the accumulated journal into paste-ready resume drafts for
 * JobKorea (경력기술서) and Wanted (소개글 / 주요 성과 / 스킬): one
 * `claude -p` call per project plus one for the intro. Returns the two
 * file paths, or null when there are no journal notes yet.
 */
export async function generateResumeExport() {
  const config = loadConfig();
  const notes = loadJournalNotes(config.outputDir);

  if (notes.length === 0) {
    logger.info("resume export: no journal entries found");
    return null;
  }

  // Biggest projects first, both for output order and so the most
  // important call fails fast if the CLI is unavailable.
  const groups = [...groupByProject(notes).entries()].sort((a, b) => b[1].length - a[1].length);

  const projects = [];
  for (const [key, projectNotes] of groups) {
    const generated = generateStructured({
      systemPrompt: PROJECT_SYSTEM_PROMPT,
      input: buildProjectInput(key, projectNotes),
      jsonSchema: PROJECT_SCHEMA,
      model: config.model,
    });
    projects.push({
      ...generated,
      period: periodOf(projectNotes),
      techStack: topTechStack(projectNotes, 12),
    });
  }

  const intro = generateText({
    systemPrompt: INTRO_SYSTEM_PROMPT,
    input: projects
      .map((p) => `프로젝트: ${p.project_title}\n개요: ${p.one_liner}\n역할: ${p.role}\n성과:\n${p.wanted_bullets.map((b) => `- ${b}`).join("\n")}`)
      .join("\n\n"),
    model: config.model,
  }).trim();

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(config.outputDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const jobkoreaPath = path.join(reportsDir, `resume-jobkorea-${dateStr}.md`);
  const wantedPath = path.join(reportsDir, `resume-wanted-${dateStr}.md`);
  fs.writeFileSync(jobkoreaPath, renderJobkorea(projects, dateStr), "utf8");
  fs.writeFileSync(wantedPath, renderWanted(projects, intro, topTechStack(notes, MAX_SKILLS), dateStr), "utf8");

  logger.info("resume export saved", { jobkoreaPath, wantedPath, noteCount: notes.length, projectCount: projects.length });
  return { jobkoreaPath, wantedPath, projectCount: projects.length };
}
