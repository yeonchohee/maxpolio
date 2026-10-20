import fs from "node:fs";
import path from "node:path";
import { loadJournalNotes, toDateStr } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";

// Tistory accepts at most 10 tags per post.
const MAX_TAGS = 10;
const MAX_FINDINGS = 30;

// First line journal-store.js puts on every part note, pointing at its main note.
const PART_BACKLINK = /^> \[\[([^\]|]+)(?:\|[^\]]*)?\]\]의 일부[ \t]*(?:\r?\n)*/;
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Strings worth a second look before the post goes public. URLs are matched
// first and blanked out so the IP inside one isn't reported twice.
const REVIEW_PATTERNS = [/\bhttps?:\/\/[^\s)>\]"'`]+/g, /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, /[\w.+-]+@[\w-]+\.[\w.-]+/g];

function titleOf(note) {
  return note.frontmatter.title ?? path.basename(note.filePath, ".md");
}

// Applies `fn` to every line that is not inside a fenced code block.
function mapProseLines(markdown, fn) {
  let fence = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      return fence ? line : fn(line);
    })
    .join("\n");
}

// Obsidian wikilinks mean nothing on Tistory. `resolve` decides what each one
// becomes; links quoted in inline code or code blocks are left alone.
function replaceWikilinks(markdown, resolve) {
  return mapProseLines(markdown, (line) =>
    line
      .split(/(`+[^`]*`+)/)
      .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(WIKILINK, (_, target, alias) => resolve(target.trim(), alias ?? target))))
      .join(""),
  );
}

function demoteHeadings(markdown) {
  return mapProseLines(markdown, (line) => line.replace(/^(#{1,5})(?=\s)/, "#$1"));
}

/**
 * Splits notes into main notes and the part notes hanging off them. A part
 * whose main note is gone is treated as a post of its own.
 */
function groupPosts(notes) {
  const byPath = new Map(notes.map((n) => [path.normalize(n.filePath), n]));
  const posts = new Map();
  const partsOf = (main) => {
    if (!posts.has(main)) posts.set(main, []);
    return posts.get(main);
  };

  for (const note of notes) {
    const parentName = note.body.match(PART_BACKLINK)?.[1].trim();
    const parent = parentName && byPath.get(path.join(path.dirname(note.filePath), `${parentName}.md`));
    if (parent && parent !== note) partsOf(parent).push(note);
    else partsOf(note);
  }

  return [...posts.entries()]
    .map(([main, parts]) => ({ main, parts }))
    .sort((a, b) => (toDateStr(b.main.frontmatter.date) ?? "").localeCompare(toDateStr(a.main.frontmatter.date) ?? ""));
}

// One self-contained post: the main note, with each part appended as its own
// section and the wikilink that pointed at it turned into a plain reference.
function buildBody({ main, parts }) {
  const partByName = new Map(parts.map((p) => [path.basename(p.filePath, ".md"), p]));
  const linked = [];

  const mainBody = replaceWikilinks(main.body.replace(PART_BACKLINK, ""), (target, label) => {
    const part = partByName.get(target);
    if (!part) return label;
    if (!linked.includes(part)) linked.push(part);
    return `아래 '${titleOf(part)}' 참고`;
  });

  const sections = [...linked, ...parts.filter((p) => !linked.includes(p))].map((part) => {
    const partBody = replaceWikilinks(part.body.replace(PART_BACKLINK, ""), (_, label) => label);
    return `## ${titleOf(part)}\n\n${demoteHeadings(partBody)}`;
  });

  return redactSecrets([mainBody, ...sections].join("\n\n---\n\n")).trim();
}

function tistoryTags(frontmatter) {
  const seen = new Set();
  const tags = [];
  for (const raw of [...(frontmatter.tags ?? []), ...(frontmatter.tech_stack ?? [])]) {
    const tag = String(raw).replace(/,/g, " ").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

function findReviewStrings(body) {
  const found = new Set();
  let rest = body;
  for (const pattern of REVIEW_PATTERNS) {
    rest = rest.replace(pattern, (match) => {
      found.add(match);
      return " ";
    });
  }
  return [...found];
}

// A fence longer than any backtick run in the body, so the body's own code
// blocks don't close the block it is wrapped in.
function fenceFor(body) {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function renderDraft({ title, category, tags, body, findings }) {
  const lines = [
    `# 티스토리 글 초안: ${title}`,
    "",
    "> 올리기 전에 꼭 확인:",
    "> - 업무 세션에서 나온 글이야. 회사 내부 정보(서버 주소, 고객사, 내부 프로젝트명, 담당자 이름)가 남아 있지 않은지 훑어봐.",
    "> - 처음엔 '비공개'로 저장해서 코드 블록·표가 제대로 보이는지 확인한 뒤 공개로 바꿔.",
    "",
  ];

  if (findings.length > 0) {
    lines.push("## 공개 전에 확인할 문자열", "", "본문에 주소·IP·이메일처럼 보이는 문자열이 있어. 내부 것이면 지우거나 일반화해.", "");
    for (const f of findings.slice(0, MAX_FINDINGS)) lines.push(`- \`${f}\``);
    if (findings.length > MAX_FINDINGS) lines.push(`- ...외 ${findings.length - MAX_FINDINGS}개`);
    lines.push("");
  }

  lines.push("## 제목", "", "```text", title, "```", "");
  lines.push("## 카테고리", "", `저널 카테고리는 "${category ?? "-"}" — 티스토리에 같은 카테고리가 없으면 먼저 만들거나 비슷한 걸 골라.`, "");
  lines.push("## 태그", "", "```text", tags.join(", "), "```", "");

  const fence = fenceFor(body);
  lines.push("## 본문", "", "글쓰기 화면에서 에디터 모드를 '기본모드'에서 '마크다운'으로 바꾼 뒤, 아래 코드 블록 안의 내용을 붙여넣어.", "");
  lines.push(`${fence}markdown`, body, fence, "");
  return lines.join("\n");
}

/**
 * Lists the journal entries that can be exported as blog posts (part notes
 * are folded into their main note), newest first.
 */
export function listBlogPosts() {
  const config = loadConfig();
  return groupPosts(loadJournalNotes(config.outputDir)).map(({ main, parts }) => ({
    title: titleOf(main),
    date: toDateStr(main.frontmatter.date),
    category: main.frontmatter.category,
    partCount: parts.length,
  }));
}

/**
 * Converts journal entries into paste-ready Tistory drafts under
 * `reports/blog/`. Tistory has no posting API (the Open API was shut down),
 * so like the resume export this stops at a draft to paste. Purely a format
 * conversion - no `claude -p` call. `query` picks entries by title substring;
 * `all` exports every entry. Returns the drafts written (empty if nothing
 * matched).
 */
export function generateBlogExport({ query, all }) {
  const config = loadConfig();
  const needle = (query ?? "").toLowerCase();
  const posts = groupPosts(loadJournalNotes(config.outputDir)).filter(
    ({ main }) => all || titleOf(main).toLowerCase().includes(needle) || path.basename(main.filePath, ".md").toLowerCase().includes(needle),
  );

  const blogDir = path.join(config.outputDir, "reports", "blog");
  const drafts = [];
  for (const post of posts) {
    const title = titleOf(post.main);
    const body = buildBody(post);
    const findings = findReviewStrings(body);
    const filePath = path.join(blogDir, path.basename(post.main.filePath));

    fs.mkdirSync(blogDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      renderDraft({ title, category: post.main.frontmatter.category, tags: tistoryTags(post.main.frontmatter), body, findings }),
      "utf8",
    );
    drafts.push({ title, filePath, findingCount: findings.length });
  }

  logger.info("blog export saved", { count: drafts.length, blogDir });
  return drafts;
}
