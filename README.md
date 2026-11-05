# maxpolio

Claude Code 세션을 자동으로 정리해 기술 저널(Obsidian 호환 마크다운)로 쌓고, 그 저널로 블로그 글·포트폴리오·이력서 초안·강점 리포트를 만든다.

- 코드: 이 저장소
- 저널(출력물): [maxpolio-journal](https://github.com/yeonchohee/maxpolio-journal) — 기본 경로 `~/maxpolio-journal`
- 설정·상태: `~/.maxpolio/` (git에 없음, 컴퓨터마다 따로)

## 새 컴퓨터에서 세팅하기

### 0. 준비물

- Node.js 18 이상
- Git
- [Claude Code](https://claude.com/claude-code) CLI — 설치 후 `claude`로 로그인까지 해둔다. 저널 정리는 로그인된 CLI로 돌아가서 별도 API 키가 필요 없다.

### 1. 저장소 받기

```bash
git clone https://github.com/yeonchohee/maxpolio.git
cd maxpolio
npm install

# 저널 저장소는 기본 출력 경로에 받는다
git clone https://github.com/yeonchohee/maxpolio-journal.git ~/maxpolio-journal
```

### 2. 설정 파일 (`~/.maxpolio/`)

아무 명령이나 처음 실행하면 `~/.maxpolio/config.json`이 기본값으로 만들어진다.

```bash
node bin/maxpolio.js config   # 현재 설정 확인
```

기본값(`outputDir: ~/maxpolio-journal`, `model: sonnet`)을 그대로 쓰면 고칠 것이 없다. 예시는 `config/config.example.json`에 있다.

**`~/.maxpolio/projects.json`은 기존 컴퓨터에서 복사해 온다.** 프로젝트 이름과 저장소를 연결하는 파일이라, 없으면 새 노트가 프로젝트에 연결되지 않는다. 형식:

```json
[
  {
    "name": "SSF 대시보드",
    "description": "프로젝트 한 줄 설명",
    "repos": ["ssf-dashboard", "ssf-dashboard-admin"]
  }
]
```

다음 파일은 컴퓨터별 기록이라 옮기지 않는다: `state.json`, `queue/`, `logs/`, `sync.lock`, `sync.vbs`.

### 3. 훅과 자동 실행 등록

```bash
node bin/maxpolio.js install-hook
```

한 번에 두 가지를 등록한다.

- `~/.claude/settings.json`에 세션이 끝날 때 도는 SessionEnd 훅
- Windows 작업 스케줄러에 30분마다 `maxpolio sync`를 실행하는 `maxpolio-sync` 작업 (주기는 `config.json`의 `syncIntervalMinutes`)

Mac·Linux에서는 작업 스케줄러 등록을 건너뛴다. 대신 cron으로 직접 건다.

```cron
*/30 * * * * node /path/to/maxpolio/bin/maxpolio.js sync
```

> 훅과 스케줄러에는 node와 이 저장소의 **절대경로**가 들어간다. 저장소 폴더를 옮기거나 Node를 다른 경로에 다시 설치했다면 `install-hook`을 다시 실행한다.

### 4. 동작 확인

```bash
node bin/maxpolio.js sync
```

`~/.maxpolio/logs/maxpolio.log`에 오류가 없고 `~/maxpolio-journal/journal/` 아래에 노트가 생기면 끝.

### (선택) `maxpolio` 명령으로 쓰기

```bash
npm link   # 이후 node bin/maxpolio.js 대신 maxpolio 로 실행
```

## 여러 컴퓨터에서 같이 쓸 때

저널은 자동으로 커밋·푸시되지 않는다. 작업 전후로 직접 맞춘다.

```bash
cd ~/maxpolio-journal
git pull                       # 시작 전
git add -A && git commit -m "저널 업데이트" && git push   # 끝난 뒤
```

## 명령어

| 명령 | 하는 일 |
| --- | --- |
| `maxpolio install-hook` | SessionEnd 훅 + 주기 실행(작업 스케줄러) 등록 |
| `maxpolio sync` | 끝난 세션과 한동안 조용한 열린 세션을 저널로 정리 (스케줄러가 호출) |
| `maxpolio report` | 누적 저널로 강점 리포트 생성 |
| `maxpolio resume` | 잡코리아·원티드 이력서에 붙여넣을 초안 생성 |
| `maxpolio blog` | 블로그 글로 다듬을 수 있는 저널 목록 |
| `maxpolio blog <제목 일부>\|--all [--force]` | 저널을 공개용 블로그 글로 다듬어 `blog/<카테고리>/`에 저장 |
| `maxpolio portfolio [프로젝트]` | 프로젝트 저널로 포트폴리오 섹션 초안 생성 |
| `maxpolio projects` | `projects/<프로젝트>.md` 인덱스 다시 만들기 (sync 때 자동) |
| `maxpolio readme` | 저널 README의 카테고리 표 갱신 (sync 때 자동) |
| `maxpolio migrate [--apply]` | 옛 카테고리 폴더의 노트를 새 카테고리로 이전 (한 번만) |
| `maxpolio test-session <path> [cwd]` | transcript JSONL 하나로 파이프라인 수동 테스트 |
| `maxpolio config` | 현재 설정 출력 |

## 설정 (`~/.maxpolio/config.json`)

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `outputDir` | `~/maxpolio-journal` | 저널·블로그·포트폴리오가 저장되는 폴더 |
| `model` | `sonnet` | 저널 정리에 쓰는 Claude 모델 |
| `idleMinutes` | `120` | 열린 세션이 이만큼 조용하면 저널로 정리 |
| `syncIntervalMinutes` | `30` | 스케줄러가 `sync`를 실행하는 주기 |
| `portfolioPath` | `이력서/포트폴리오.md` | `portfolio` 명령이 형식을 맞추는 직접 쓴 포트폴리오 (`outputDir` 기준) |
| `categories` | Backend, DevOps, Frontend, AI·LLM, 개발 생산성, 생각정리, 일반 지식 | 노트가 분류되는 고정 카테고리 |
