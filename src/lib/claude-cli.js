import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";
import { truncateLogMiddle } from "./transcript-parser.js";

const MAX_BUFFER = 20 * 1024 * 1024;
const MAX_LOG_CHARS = 120000;
const MAX_DIFF_CHARS = 40000;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs one non-interactive `claude -p` call with tools disabled (--restricted)
 * and a custom system prompt, using whatever Claude Code account is already
 * logged in on this machine (subscription usage, not a metered API key).
 * --no-session-persistence keeps these calls from leaving transcripts of
 * their own in ~/.claude/projects, which the sync scan would then see.
 */
function runClaudePrint({ systemPrompt, input, jsonSchema, model }) {
  const args = [
    "-p",
    "--restricted",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    model,
    "--system-prompt",
    systemPrompt,
  ];
  if (jsonSchema) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }

  let raw;
  try {
    raw = execFileSync("claude", args, {
      input,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    // The default message is just the (huge) command line; the actual reason
    // lives in stdout (JSON with is_error/result) or stderr.
    const stdout = (err.stdout ?? "").toString().trim();
    const stderr = (err.stderr ?? "").toString().trim();
    let reason = stderr;
    try {
      const out = JSON.parse(stdout);
      reason = [out.subtype, out.result, stderr].filter(Boolean).join(" | ");
    } catch {
      reason = [stdout.slice(0, 2000), stderr].filter(Boolean).join(" | ");
    }
    throw new Error(`claude CLI exited with code ${err.status ?? err.code}: ${reason || "(no output)"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`claude CLI returned non-JSON output: ${err.message}`);
  }

  if (parsed.is_error) {
    throw new Error(`claude CLI error: ${parsed.result ?? "unknown"}`);
  }

  return parsed;
}

const JOURNAL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    should_journal: { type: "boolean" },
    should_journal_reason: { type: "string" },
    category: { type: "string" },
    is_new_category: { type: "boolean" },
    category_description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    tech_stack: { type: "array", items: { type: "string" } },
    overview: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
        },
        required: ["heading", "body"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "title",
    "should_journal",
    "should_journal_reason",
    "category",
    "is_new_category",
    "category_description",
    "tags",
    "tech_stack",
    "overview",
    "parts",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `너는 개인 개발 저널 도구다. Claude Code 세션 로그와 git 활동을 보고, 분류와 (가치 있다면) 블로그 글을
한 번에 만든다. 반드시 주어진 JSON 스키마로만 응답한다.

분류 규칙:
- title: 세션의 핵심 주제를 나타내는 짧은 한글 제목 (10~25자, 파일명으로 쓰임). 세션 로그에 실제로 있는
  내용을 그대로 요약해야 하며, 다른 세션과 구분될 만큼 구체적이어야 한다 ("프론트엔드 개발" 같은 뭉뚱그린
  제목 금지).
- should_journal: 코드 변경이 있거나, 코드 변경이 없어도 실질적인 기술적 고민(설계 결정, 트레이드오프,
  디버깅 추론)이 대화에 있으면 true. 단순 정보성 질문이나 한 줄짜리 답변으로 끝난 세션은 false.
- category/tags/tech_stack: 기존 카테고리 목록에 비슷한 게 있으면 재사용하고, 확실히 다를 때만 새 카테고리를
  만든다.

글쓰기 규칙 (should_journal이 true일 때만 채우고, false면 overview="", parts=[]):
- 기술 블로그 포스트처럼 읽히게 써라 — 사람이 관심을 갖고 끝까지 읽고 싶어지는 글이어야 한다. 세션 로그를
  시간순으로 나열한 회의록이 아니라, "무슨 문제를 왜 겪었고 어떻게 풀었는지"를 따라가는 이야기로 재구성해라.
- 말투는 딱딱한 보고서체("~하였음", "~함")가 아니라, 개발자 개인 블로그(velog, 티스토리 등)에서 흔히 보는
  트렌디하고 힘 뺀 톤으로 써라. "-했다"/"-였다" 기본 서술에 가끔 감탄사나 반응("아니나 다를까", "찾았다",
  "역시나", "살짝 당황")을 섞어서 감정선이 느껴지게 하고, 모든 문장을 같은 톤으로 딱딱하게 반복하지 마라.
  단, 과하게 유행어를 남발하거나 이모지를 넣지는 마라 — 포트폴리오로도 쓰일 글이라 스타일은 캐주얼해도
  전문성은 유지해야 한다.
- 세션 로그나 git diff에 실제로 등장하지 않는 내용은 단 하나도 지어내지 마라. 수치, 성능 개선 폭, 에러
  메시지, 원인 분석 등은 로그에 명시적으로 나온 것만 써라. 근거 없는 섹션은 통째로 생략해라 — 모든 섹션을
  억지로 채우지 마라.
- frontmatter나 H1 제목은 쓰지 마라 (별도 시스템이 붙인다). H2/H3만 써라.
- 실제 코드 조각을 근거로 보여줄 때는 로그/diff에 있는 코드를 그대로 인용하되, 꼭 필요한 부분만 짧게
  인용해라 — 파일 전체를 붙여넣지 마라.

overview와 parts를 나누는 기준 — "핵심 줄기 vs 곁가지":
- 먼저 이 세션을 관통하는 "핵심 줄기"(가장 중요한 하나의 목표/과정, 예: "CI/CD 배포를 처음부터 끝까지 어떻게
  해냈는가")를 찾아라. overview는 이 핵심 줄기를 시작부터 끝까지 빠짐없이 따라가는, 그 자체로 완결된 글이어야
  한다 — overview 하나만 읽어도 "결국 무엇을 어떻게 해냈는지" 전체 흐름이 다 이해돼야 한다. 절대 개요/목차만
  던지고 실제 단계별 내용을 다른 글로 떠넘기지 마라.
- 핵심 줄기에 속하는 단계들(문제 발견 → 원인 파악 → 해결로 이어지는 흐름)은 절대 parts로 쪼개지 마라. 그러면
  overview만 읽었을 때 이야기가 중간에 끊긴다. 그 전개는 전부 overview 안에서 순서대로 서술해라.
- parts는 핵심 줄기에서 살짝 벗어난, 그 자체로 독립적인 곁가지 에피소드를 위한 것이다 (예: 핵심 작업 도중
  우연히 발견해서 고친 별개의 버그, 본 흐름과 직접 상관없는 부수적 디버깅/삽질). 이런 곁가지가 없으면
  parts는 빈 배열로 둬라 — 억지로 쪼개지 마라.
- overview는 맨 위에 3줄 이내 TL;DR을 굵게 표시하고 (예: "**TL;DR**: 이러이러한 문제를 이런 방법으로
  해결했다."), 그 아래 "배경 - 문제 - 시도 - 해결 - 회고" 흐름을 따르되 H2 제목은 그 단어 그대로 쓰지 말고
  실제 내용을 담은 구체적인 제목을 써라 (예: "## 배경" 대신 "## 배포 파이프라인이 하나도 없던 상태").
- parts가 있을 때는, overview에서 그 곁가지가 실제로 일어난 지점에 자연스럽게 [[PART:0]], [[PART:1]]...
  링크를 걸고(0부터 시작, parts 배열 순서와 반드시 일치해야 함), 곧바로 다음 문장에서 핵심 줄기로 돌아와
  이야기를 이어가라 — 예: "이 과정에서 Swagger 기본값 버그도 하나 발견해서 고쳤다 ([[PART:0]]). 배포
  런북은 계속해서...". 링크가 이야기의 흐름을 끊으면 안 된다. 이 토큰은 나중에 실제 링크로 자동
  치환되니 그대로 남겨둬라.
  각 parts[i].heading은 title과 같은 규칙(짧고 구체적인 한글 제목, 10~25자)을 따르고, parts[i].body는
  TL;DR 없이 바로 본문으로 들어가는 완결된 미니 글이어야 한다 (역시 위 글쓰기 규칙 전부 적용).
- 여러 개의 독립된 이슈를 한 글(overview 또는 하나의 part) 안에서 나열할 때도, 그냥 번호 목록으로 던지지
  말고 각각을 짧은 소제목(### 또는 굵은 문장)이 있는 미니 섹션으로 만들어서 앞뒤 문맥과 함께 서술해라.
- 문장은 담백하되 리듬감 있게 — 짧은 문장과 좀 더 설명적인 문장을 섞어라. 같은 문장 패턴("~했다. ~했다.
  ~했다.")이 기계적으로 반복되지 않게 해라.`;

function buildPrompt({ sessionLog, gitActivity, existingCategories }) {
  const categoryList =
    existingCategories.length > 0
      ? existingCategories.map((c) => `- ${c.name}: ${c.description}`).join("\n")
      : "(no existing categories yet — this may be the first one)";

  const gitSummary = gitActivity
    ? [
        gitActivity.commitLog ? `커밋:\n${gitActivity.commitLog}` : "커밋 없음",
        gitActivity.uncommittedDiff
          ? `--- Uncommitted diff ---\n${truncateLogMiddle(gitActivity.uncommittedDiff, MAX_DIFF_CHARS)}`
          : "Uncommitted diff 없음",
      ].join("\n\n")
    : "git 저장소 아님";

  return `기존 카테고리 목록 (비슷한 게 있으면 재사용하고, 확실히 다를 때만 새 카테고리를 만들어):
${categoryList}

--- Git 활동 ---
${gitSummary}

--- 세션 로그 ---
${truncateLogMiddle(sessionLog, MAX_LOG_CHARS)}`;
}

/**
 * Single combined classify+write call. Doing both in one invocation (one
 * schema, one system prompt) avoids paying Claude Code's ~10-13K token
 * per-call harness overhead twice per session.
 */
export function generateJournalEntry({ sessionLog, gitActivity, existingCategories, model }) {
  const result = runClaudePrint({
    systemPrompt: SYSTEM_PROMPT,
    input: buildPrompt({ sessionLog, gitActivity, existingCategories }),
    jsonSchema: JOURNAL_SCHEMA,
    model,
  });

  const output = result.structured_output;
  if (!output) {
    throw new Error("claude CLI returned no structured_output");
  }

  logger.info("claude-cli generation usage", { usage: result.usage, cost_usd: result.total_cost_usd });

  const { overview, parts, ...classification } = output;
  return { classification, overview, parts };
}

/**
 * Plain-text generation (no schema) — used by the strength report, which
 * just needs a markdown document back.
 */
export function generateText({ systemPrompt, input, model }) {
  const result = runClaudePrint({ systemPrompt, input, model });
  logger.info("claude-cli text usage", { usage: result.usage, cost_usd: result.total_cost_usd });
  return result.result;
}

/**
 * Schema-constrained generation for callers that bring their own prompt and
 * schema (the resume export).
 */
export function generateStructured({ systemPrompt, input, jsonSchema, model }) {
  const result = runClaudePrint({ systemPrompt, input, jsonSchema, model });
  if (!result.structured_output) {
    throw new Error("claude CLI returned no structured_output");
  }
  logger.info("claude-cli structured usage", { usage: result.usage, cost_usd: result.total_cost_usd });
  return result.structured_output;
}
