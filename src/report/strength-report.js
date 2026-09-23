import fs from "node:fs";
import path from "node:path";
import { aggregateJournal } from "./aggregate.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { generateText } from "../lib/claude-cli.js";

const SYSTEM_PROMPT = `너는 개발자의 누적 작업 저널 통계를 보고 강점 리포트를 써주는 분석가다. 아래 JSON 집계 데이터만 근거로
"카테고리별 비중, 최근 추세, 강점 후보"를 담은 마크다운 리포트를 작성해라. 데이터에 없는 숫자나 카테고리는
절대 지어내지 마라. 데이터가 너무 적으면(예: 총 5건 미만) 그 사실을 그대로 언급하고 성급한 결론을 내리지 마라.`;

function buildDataviewBlock() {
  return [
    "",
    "---",
    "",
    "> 아래는 참고용 Dataview 쿼리입니다 (Obsidian Dataview 플러그인이 있을 때만 렌더링됩니다; 없어도 이 리포트 자체는 정상적으로 보입니다).",
    "",
    "```dataview",
    "TABLE length(rows) as 건수",
    'FROM "" ',
    "WHERE category",
    "GROUP BY category",
    "SORT length(rows) DESC",
    "```",
    "",
  ].join("\n");
}

export async function generateStrengthReport() {
  const config = loadConfig();
  const stats = aggregateJournal(config.outputDir);

  if (stats.totalCount === 0) {
    logger.info("strength report: no journal entries found");
    return null;
  }

  const body = generateText({
    systemPrompt: SYSTEM_PROMPT,
    input: JSON.stringify(stats, null, 2),
    model: config.model,
  }).trim();

  const dateStr = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(config.outputDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `strength-report-${dateStr}.md`);

  const frontmatter = `---\ntitle: Strength Report ${dateStr}\ndate: ${dateStr}\n---\n\n`;
  fs.writeFileSync(filePath, frontmatter + body + "\n" + buildDataviewBlock(), "utf8");

  logger.info("strength report saved", { filePath, totalCount: stats.totalCount });
  return filePath;
}
