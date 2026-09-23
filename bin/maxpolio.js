#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.js";
import { generateStrengthReport } from "../src/report/strength-report.js";
import { runPipeline } from "../src/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HOOK_ENTRY_PATH = path.join(PROJECT_ROOT, "src", "hook-entry.js");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

function buildHookCommand() {
  return `"${process.execPath}" "${HOOK_ENTRY_PATH}"`;
}

function installHook() {
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
    } catch (err) {
      console.error(`~/.claude/settings.json 파싱 실패, 직접 확인해줘: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];

  const command = buildHookCommand();
  const alreadyInstalled = settings.hooks.SessionEnd.some((group) =>
    (group.hooks ?? []).some((h) => h.command === command),
  );

  if (alreadyInstalled) {
    console.log("이미 SessionEnd 훅이 등록되어 있음 — 변경 없음.");
  } else {
    settings.hooks.SessionEnd.push({
      hooks: [{ type: "command", command, timeout: 10 }],
    });
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
    console.log(`SessionEnd 훅을 등록했어: ${CLAUDE_SETTINGS_PATH}`);
  }

  const config = loadConfig();
  console.log(`\n저널이 저장될 위치: ${config.outputDir}`);
  console.log("Obsidian에서 위 폴더를 vault로 열면 카테고리/태그별로 바로 탐색할 수 있어.");
  console.log(
    "\n분류/생성은 이 PC에 로그인된 Claude Code 계정(구독 사용량)으로 처리돼 — 별도 API 키 설정 필요 없음. " +
      "세션 종료 훅이 백그라운드에서 `claude -p`를 호출하니, 이 계정이 로그아웃 상태면 파이프라인이 실패하고 " +
      "로그만 남아.",
  );
}

async function report() {
  const filePath = await generateStrengthReport();
  if (filePath) {
    console.log(`강점 리포트 생성 완료: ${filePath}`);
  } else {
    console.log("저널 항목이 아직 없어서 리포트를 생성하지 않았어.");
  }
}

async function testSession(transcriptPath, cwd) {
  if (!transcriptPath) {
    console.error("사용법: maxpolio test-session <transcript_path> [cwd]");
    process.exitCode = 1;
    return;
  }
  const sessionId = `test-${Date.now()}`;
  const result = await runPipeline({ sessionId, transcriptPath, cwd: cwd ?? process.cwd() });
  console.log(JSON.stringify(result, null, 2));
}

function printConfig() {
  console.log(JSON.stringify(loadConfig(), null, 2));
}

function printHelp() {
  console.log(`maxpolio - Claude Code 세션 자동 저널 + 강점 리포트

사용법:
  maxpolio install-hook            ~/.claude/settings.json에 SessionEnd 훅 등록
  maxpolio report                  누적 저널로 강점 리포트 생성
  maxpolio test-session <path> [cwd]  transcript JSONL 하나로 파이프라인 수동 테스트 (동기 실행, 결과 출력)
  maxpolio config                  현재 설정 출력
`);
}

const [, , command, ...args] = process.argv;

switch (command) {
  case "install-hook":
    installHook();
    break;
  case "report":
    await report();
    break;
  case "test-session":
    await testSession(args[0], args[1]);
    break;
  case "config":
    printConfig();
    break;
  default:
    printHelp();
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
}
