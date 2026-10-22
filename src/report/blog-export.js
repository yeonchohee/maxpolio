import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { loadJournalNotes, toDateStr } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { generateStructured } from "../lib/claude-cli.js";
import { generateProjectIndexes } from "./project-index.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";

// Tistory accepts at most 10 tags per post.
const MAX_TAGS = 10;

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

const POLISH_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" }, maxItems: MAX_TAGS },
    body: { type: "string" },
  },
  required: ["title", "tags", "body"],
  additionalProperties: false,
};

const POLISH_SYSTEM_PROMPT = `너는 개발자 개인 기술 블로그(티스토리)의 편집자다. 작성자가 업무 중에 남긴 개발 저널(원본)을 받아서,
처음 보는 독자가 읽는 공개용 블로그 글로 다시 쓴다. 반드시 주어진 JSON 스키마로만 응답한다.

독자 관점으로 다시 쓰기:
- 원본은 작성자 본인 기록이라 맥락이 생략돼 있다. 독자가 "어떤 상황에서 무슨 문제를 만났고, 어떻게 풀었고,
  나라면 뭘 가져갈 수 있는지"를 따라갈 수 있게 도입 → 문제 → 원인/시도 → 해결 → 정리 순서로 재구성해라.
  H2 제목은 그 단어 그대로 쓰지 말고 내용이 드러나는 구체적인 제목으로 써라.
- 맨 앞에 독자가 이 글에서 얻어갈 것을 2~3문장으로 소개하고, 끝에는 핵심 교훈이나 비슷한 상황에서 써먹을 수
  있는 체크포인트를 짧게 정리해라.
- 원본에 없는 사실(수치, 에러 메시지, 원인, 결과)은 절대 지어내지 마라. 설명을 보충하는 건 괜찮지만, 일반적인
  기술 배경 설명에 그쳐야 한다.
- 원본의 "TL;DR", "곁가지 참고" 같은 저널용 장치나 "세션", "Claude가 ~했다" 같은 작업 로그 말투는 걷어내고
  작성자 1인칭 경험담으로 써라.
- 코드는 핵심만 남기고, 원본에 있는 코드만 써라.
- 티스토리는 Obsidian 전용 문법을 그리지 못한다. 원본의 Mermaid 다이어그램(\`\`\`mermaid 블록)은 지우고, 그 흐름을
  번호 목록이나 "A → B → C" 같은 한 줄 흐름으로 풀어 써라. 콜아웃(\`> [!summary]\` 등)은 \`[!...]\` 표시를 뺀 일반
  인용문이나 굵은 문장으로 바꿔라. 표와 코드 블록은 그대로 써도 된다.
- 카테고리가 "생각정리"(기술 외 이야기)면 위의 문제-해결 구조 대신, 고민의 배경 → 오간 생각들 → 지금의
  생각 순서의 에세이로 써라. 끝을 교훈으로 억지로 포장하지 말고, 결론이 없으면 열린 채로 둬라.

공개 전 정보 일반화 (가장 중요):
- 개인적인 고민 글에서는 지원한 회사, 면접관, 현 직장 동료처럼 특정할 수 있는 사람·조직을 드러내지 마라
  (예: "OO마켓 면접" → "한 이커머스 회사 면접"). 연봉 같은 민감한 숫자도 빼라.
- 회사 내부 정보는 일반적인 표현으로 바꿔라: 회사·고객사·협력사 이름, 내부 프로젝트/서비스 이름, 사람 이름,
  내부 서버 주소·IP·도메인·포트, 계정, 내부 브랜치/저장소 경로, 사내 시스템 이름.
  예: "OO건설 현장 대시보드" → "건설 현장용 대시보드", "10.0.3.12:8080" → "<서버 주소>".
- 공개 기술 이름(Spring Boot, GitLab CI, Autodesk APS 같은 제품·라이브러리)은 그대로 둬도 된다.

형식:
- title: 검색으로 들어온 독자가 클릭하고 싶어지는 구체적인 한글 제목 (내부 이름 없이).
- tags: 기술 키워드 위주로 최대 10개. 내부 프로젝트명·회사명은 넣지 마라.
- body: 티스토리 마크다운 모드에 붙여넣을 본문. H1과 frontmatter는 쓰지 말고 H2/H3만 써라.
- 말투는 원본처럼 "-했다"체의 힘 뺀 개인 블로그 톤을 유지하되, 이모지와 과한 유행어는 쓰지 마라.`;

function blogPathOf(config, main) {
  const category = path.basename(path.dirname(main.filePath));
  return path.join(config.blogDir, category, path.basename(main.filePath));
}

// Vault-relative wikilink, so it still resolves even though the blog note
// has the same filename as its original.
function sourceLinkOf(config, main) {
  const rel = path.relative(config.outputDir, main.filePath).split(path.sep).join("/").replace(/\.md$/, "");
  return `[[${rel}|원본]]`;
}

function buildPolishInput(post, body) {
  const fm = post.main.frontmatter;
  return [
    `원본 제목: ${titleOf(post.main)}`,
    `카테고리: ${fm.category ?? "-"}`,
    `원본 태그: ${tistoryTags(fm).join(", ")}`,
    "",
    "--- 원본 본문 ---",
    body,
  ].join("\n");
}

function renderBlogNote({ config, post, polished, findings }) {
  const fm = post.main.frontmatter;
  const frontmatter = {
    title: polished.title,
    category: fm.category,
    ...(fm.project ? { project: fm.project } : {}),
    tags: polished.tags.slice(0, MAX_TAGS),
    date: toDateStr(fm.date),
    source: sourceLinkOf(config, post.main),
    published: false,
  };
  if (findings.length > 0) frontmatter.check_before_publish = findings;
  return `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n\n${polished.body.trim()}\n`;
}

function loadPosts(config) {
  return groupPosts(loadJournalNotes(config.journalDir));
}

/**
 * Lists the journal entries that can be turned into blog posts (part notes
 * are folded into their main note), newest first, and whether a blog
 * version already exists.
 */
export function listBlogPosts() {
  const config = loadConfig();
  return loadPosts(config).map((post) => ({
    title: titleOf(post.main),
    date: toDateStr(post.main.frontmatter.date),
    category: post.main.frontmatter.category,
    partCount: post.parts.length,
    hasBlog: fs.existsSync(blogPathOf(config, post.main)),
  }));
}

/**
 * Rewrites journal entries into reader-facing blog posts with one
 * `claude -p` call each, saved under `blog/<category>/` with the same
 * filename as the original. Tistory has no posting API, so this stops at a
 * note whose body is pasted into the Markdown editor. Existing blog notes
 * are kept (they may have been edited by hand) unless `force` is set.
 * `onPost` is called before each generation, for progress output.
 */
export function generateBlogExport({ query, all, force, onPost }) {
  const config = loadConfig();
  const needle = (query ?? "").toLowerCase();
  const posts = loadPosts(config).filter(
    ({ main }) => all || titleOf(main).toLowerCase().includes(needle) || path.basename(main.filePath, ".md").toLowerCase().includes(needle),
  );

  const results = [];
  for (const post of posts) {
    const title = titleOf(post.main);
    const filePath = blogPathOf(config, post.main);
    if (!force && fs.existsSync(filePath)) {
      results.push({ title, filePath, status: "exists" });
      continue;
    }

    onPost?.(title);
    let polished;
    try {
      polished = generateStructured({
        systemPrompt: POLISH_SYSTEM_PROMPT,
        input: buildPolishInput(post, buildBody(post)),
        jsonSchema: POLISH_SCHEMA,
        model: config.model,
      });
    } catch (err) {
      logger.error("blog polish failed", { error: err, title });
      results.push({ title, filePath, status: "error", error: err.message });
      continue;
    }

    polished.body = redactSecrets(polished.body);
    const findings = findReviewStrings(polished.body);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderBlogNote({ config, post, polished, findings }), "utf8");
    results.push({ title, filePath, status: "saved", findingCount: findings.length });
  }

  // Project indexes link blog versions next to their originals.
  if (results.some((r) => r.status === "saved")) generateProjectIndexes();
  logger.info("blog export done", { count: results.length, blogDir: config.blogDir });
  return results;
}
