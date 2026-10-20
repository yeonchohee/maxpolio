#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/lib/config.js";
import { MAXPOLIO_HOME, SYNC_LAUNCHER_PATH, SYNC_TASK_NAME } from "../src/lib/paths.js";
import { runSync } from "../src/sync.js";
import { generateStrengthReport } from "../src/report/strength-report.js";
import { generateResumeExport } from "../src/report/resume-export.js";
import { generateBlogExport, listBlogPosts } from "../src/report/blog-export.js";
import { runPipeline } from "../src/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HOOK_ENTRY_PATH = path.join(PROJECT_ROOT, "src", "hook-entry.js");
const CLI_PATH = path.join(PROJECT_ROOT, "bin", "maxpolio.js");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

function buildHookCommand() {
  return `"${process.execPath}" "${HOOK_ENTRY_PATH}"`;
}

// Registers the Windows scheduled task that runs `maxpolio sync`. It goes
// through a .vbs launcher because Task Scheduler would otherwise flash a
// console window on every run.
function installSyncTask(intervalMinutes) {
  if (process.platform !== "win32") {
    console.log("\n주기 실행 등록은 Windows 작업 스케줄러만 지원해 — 다른 OS에서는 cron 등으로 `maxpolio sync`를 직접 걸어줘.");
    return;
  }

  fs.mkdirSync(MAXPOLIO_HOME, { recursive: true });
  const run = `"${process.execPath}" "${CLI_PATH}" sync`;
  fs.writeFileSync(
    SYNC_LAUNCHER_PATH,
    `CreateObject("WScript.Shell").Run "${run.replaceAll('"', '""')}", 0, False\r\n`,
    "utf8",
  );

  const psQuote = (s) => `'${s.replaceAll("'", "''")}'`;
  const launcherArg = psQuote(`"${SYNC_LAUNCHER_PATH}"`);
  const script = [
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${launcherArg}`,
    `$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${intervalMinutes})`,
    "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${psQuote(SYNC_TASK_NAME)} -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
  ].join("; ");

  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
    console.log(`\n작업 스케줄러에 '${SYNC_TASK_NAME}' 등록 완료 — ${intervalMinutes}분마다 maxpolio sync 실행.`);
  } catch (err) {
    console.error(`\n작업 스케줄러 등록 실패: ${(err.stderr ?? err.message).toString().trim()}`);
    process.exitCode = 1;
  }
}

async function sync() {
  const result = await runSync();
  console.log(JSON.stringify(result));
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
  installSyncTask(config.syncIntervalMinutes);
  console.log(`\n저널이 저장될 위치: ${config.outputDir}`);
  console.log("Obsidian에서 위 폴더를 vault로 열면 카테고리/태그별로 바로 탐색할 수 있어.");
  console.log(
    "\n분류/생성은 이 PC에 로그인된 Claude Code 계정(구독 사용량)으로 처리돼 — 별도 API 키 설정 필요 없음. " +
      "`maxpolio sync`가 백그라운드에서 `claude -p`를 호출하니, 이 계정이 로그아웃 상태면 파이프라인이 실패하고 " +
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

async function resume() {
  const result = await generateResumeExport();
  if (result) {
    console.log(`이력서 초안 생성 완료 (프로젝트 ${result.projectCount}개):`);
    console.log(`  잡코리아: ${result.jobkoreaPath}`);
    console.log(`  원티드:   ${result.wantedPath}`);
    console.log("붙여넣기 전에 기간·수치·내부 정보는 직접 확인해줘.");
  } else {
    console.log("저널 항목이 아직 없어서 이력서 초안을 생성하지 않았어.");
  }
}

function blog(args) {
  const all = args.includes("--all");
  const query = args.filter((a) => a !== "--all").join(" ").trim();

  if (!all && !query) {
    const posts = listBlogPosts();
    if (posts.length === 0) {
      console.log("저널 항목이 아직 없어.");
      return;
    }
    console.log("블로그 초안으로 뽑을 수 있는 글 (최신순):\n");
    for (const p of posts) {
      const parts = p.partCount > 0 ? ` (+곁가지 ${p.partCount}개 포함)` : "";
      console.log(`  ${p.date ?? "날짜 없음"}  [${p.category ?? "-"}] ${p.title}${parts}`);
    }
    console.log("\n`maxpolio blog <제목 일부>` 또는 `maxpolio blog --all`로 초안을 만들어.");
    return;
  }

  const drafts = generateBlogExport({ query, all });
  if (drafts.length === 0) {
    console.log(`"${query}"에 해당하는 저널 글이 없어. \`maxpolio blog\`로 목록을 확인해봐.`);
    process.exitCode = 1;
    return;
  }
  console.log(`티스토리 초안 ${drafts.length}개 생성 완료:`);
  for (const d of drafts) {
    const review = d.findingCount > 0 ? `  ← 확인할 주소/IP/이메일 ${d.findingCount}개` : "";
    console.log(`  ${d.filePath}${review}`);
  }
  console.log("티스토리 글쓰기에서 에디터를 '마크다운' 모드로 바꾸고 본문을 붙여넣어. 내부 정보는 올리기 전에 직접 확인해줘.");
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
  maxpolio install-hook            ~/.claude/settings.json에 SessionEnd 훅 + 주기 실행(작업 스케줄러) 등록
  maxpolio sync                    종료된 세션 + 한동안 조용한 열린 세션을 저널링 (스케줄러가 호출)
  maxpolio report                  누적 저널로 강점 리포트 생성
  maxpolio resume                  누적 저널로 잡코리아/원티드 이력서 붙여넣기용 초안 생성
  maxpolio blog                    티스토리 초안으로 뽑을 수 있는 저널 글 목록
  maxpolio blog <제목 일부>|--all   저널 글을 티스토리 마크다운 모드 붙여넣기용 초안으로 변환
  maxpolio test-session <path> [cwd]  transcript JSONL 하나로 파이프라인 수동 테스트 (동기 실행, 결과 출력)
  maxpolio config                  현재 설정 출력
`);
}

const [, , command, ...args] = process.argv;

switch (command) {
  case "install-hook":
    installHook();
    break;
  case "sync":
    await sync();
    break;
  case "report":
    await report();
    break;
  case "resume":
    await resume();
    break;
  case "blog":
    blog(args);
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
