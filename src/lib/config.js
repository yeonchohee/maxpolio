import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, MAXPOLIO_HOME, expandHome } from "./paths.js";
import { logger } from "./logger.js";

const DEFAULT_CONFIG = {
  outputDir: "~/maxpolio-journal",
  // Runs through the locally logged-in Claude Code CLI (subscription usage,
  // no separate API key). See src/lib/claude-cli.js.
  model: "sonnet",
  // A session that is still open gets (re)journaled once it has been quiet
  // for this long and its transcript has grown since the last run.
  idleMinutes: 120,
  // How often the scheduled task runs `maxpolio sync`.
  syncIntervalMinutes: 30,
  // Hand-written portfolio (relative to outputDir) that `maxpolio portfolio`
  // matches its format to and checks for missing cases.
  portfolioPath: "이력서/포트폴리오.md",
  // Fixed, tech-blog style categories. The model must pick one of these;
  // project or domain names go into tags instead of becoming categories.
  // `example` is optional and only shown in the journal README.
  categories: [
    { name: "Backend", description: "서버 애플리케이션, API, 외부 서비스 연동, DB/JPA, 인증·세션", example: "Spring 세션 설정 질문" },
    { name: "DevOps", description: "CI/CD, 빌드·배포, 서버·OS 환경 설정, 운영 이슈", example: "대시보드 프로젝트의 배포 작업" },
    { name: "Frontend", description: "웹 UI, 화면·차트·레이아웃, 브라우저 동작, 인쇄/PDF 출력", example: "위젯 레이아웃 수정" },
    { name: "AI·LLM", description: "RAG, 임베딩·검색 품질, LLM 연동과 프롬프트, AI 서비스 설계", example: "검색 품질 개선" },
    { name: "개발 생산성", description: "개발 도구·자동화, 워크플로, Git 사용법, 학습 정리", example: "Claude Code 사용법 질문" },
    { name: "생각정리", description: "기술 외 이야기: 커리어·이직·면접 고민, 고민 상담, 회고, 일하는 방식에 대한 개인적인 생각", example: "이직 고민 상담" },
    { name: "일반 지식", description: "개발·커리어와 무관한 정보성 질문: 생활, 금융, 언어·번역, 상식 등", example: "생활, 금융, 번역 질문" },
  ],
};

export function loadConfig() {
  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    logger.info("created default config", { path: CONFIG_PATH });
  }

  let userConfig = {};
  try {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    logger.error("failed to parse config.json, falling back to defaults", { error: err, path: CONFIG_PATH });
  }

  const merged = { ...DEFAULT_CONFIG, ...userConfig };

  merged.outputDir = expandHome(merged.outputDir);
  // Original journal notes and the polished blog versions live side by side,
  // each split into the same category folders.
  merged.journalDir = path.join(merged.outputDir, "journal");
  merged.blogDir = path.join(merged.outputDir, "blog");
  return merged;
}
