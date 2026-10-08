# secrets-guard

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-24%20passing-brightgreen.svg)](hooks/secrets-guard.test.mjs)
[![Claude Code hook](https://img.shields.io/badge/Claude%20Code-PreToolUse%20hook-8A2BE2.svg)](#설치)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

Claude Code 에이전트가 API 키·암호·토큰·`.env` 파일이 든 채로 `git add` / `git commit`을 실행하려 하면 그 자리에서 막는 `PreToolUse` 훅.

[English README](README.md)

왜 만들었나: 에이전트가 진짜 자격증명이 든 파일을 들여다보지도 않고 커밋한 사고가 실제로 있었다. 커밋된 비밀은 git 히스토리에 영원히 남고, 푸시 한 번이면 유출이다. 프롬프트는 부탁이고 훅은 집행이다. 이 훅은 집행한다.

## 동작

Bash / PowerShell 도구 명령에 `git add`나 `git commit`이 들어 있으면 실행 직전에:

1. 커밋에 들어갈 파일을 모은다. 이미 스테이징된 파일 + (`git add`, `git commit -a/-am`이면) 작업 트리의 변경·신규 파일. 삭제는 검사하지 않아서, 새어 나간 `.env`를 지우는 정리 커밋은 막히지 않는다.
2. 파일명을 금지 목록과 대조한다.
3. 파일 내용(앞 1MB, 최대 300개)을 비밀 패턴과 대조한다.
4. 하나라도 걸리면 stderr에 사유를 적고 exit 2로 끝낸다. Claude Code는 그 도구 호출을 거부하고 사유를 모델에게 보여준다.

복합 명령의 `cd`를 따라가고(`cd ../other && git commit`), 파일명을 NUL 구분으로 읽어 한글 파일명도 처리하며, 널바이트 하나로 스캔을 무력화하는 우회도 막는다.

## 무엇을 막고 무엇을 경고하나

| 분류 | 패턴 | 일반 파일 | 테스트 파일* |
|---|---|---|---|
| 확정 키 형식 | AWS `AKIA…` · Anthropic `sk-ant-…` · OpenAI류 `sk-…` · GitHub `ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_` · Slack `xox[baprs]-`, `xapp-` · Google `AIza…`, `ya29.` · Stripe `sk_live_/rk_live_` · GitLab `glpat-` · npm `npm_` · HuggingFace `hf_` · `-----BEGIN … PRIVATE KEY-----` | **차단** | **차단** |
| 휴리스틱 | `password / passwd / secret / api_key / access_token / auth_token` `= "값"` (따옴표, 8자 이상) 또는 무따옴표(16자 이상 + 숫자 포함) · DB 접속 URL의 `user:pass@` (`postgres`, `mysql`, `mongodb`, `redis`, `amqp`) | **차단** | **경고만** |
| 금지 파일명 | `.env`, `.env.*` (`.env.example`, `.env.sample`, `.env.template` 제외) · `*.pem` · `id_rsa`, `id_ed25519`, `id_ecdsa` · `*.key`, `*.p12`, `*.pfx` | **차단** | **차단** |

\* 테스트 파일 = 경로가 `*.test.*`, `*.spec.*`, `tests/`, `__tests__/`에 해당.

경고는 명령을 막지 않는다. 파일명과 패턴을 `additionalContext`로 모델에게 넣어 주어, 값이 진짜 비밀이면 모델이 스스로 멈출 수 있게 한다.

## 설치

**1. 파일 복사**

```
git clone https://github.com/Youkamii/secrets-guard.git
cd secrets-guard
node install.mjs
```

`hooks/secrets-guard.mjs`를 `~/.claude/hooks/`로, `skills/secrets-guard/SKILL.md`를 `~/.claude/skills/secrets-guard/`로 복사하고, 이 PC에 맞는 settings 스니펫을 출력한다. (손으로 복사해도 된다.)

**2. 훅 등록** — `~/.claude/settings.json`(또는 프로젝트의 `.claude/settings.json`)에 추가. 경로는 절대 경로로, Windows에서도 슬래시를 쓰면 된다.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/you/.claude/hooks/secrets-guard.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`node install.mjs --write-settings`를 쓰면 `~/.claude/settings.json`에 자동으로 병합하고 백업(`settings.json.bak-secrets-guard`)을 남긴다. 훅은 세션 시작 때 읽히므로 Claude Code를 다시 시작한다.

**3. 확인**

```
node install.mjs --check
```

또는 무따옴표 휴리스틱(16자 이상 + 숫자)에 걸리는 줄을 스테이징한 임시 저장소에서 가짜 도구 호출을 흘려 넣어 본다.

```
git init scratch && cd scratch
echo "password: $(date +%s)-not-a-real-secret" > cfg.yaml && git add cfg.yaml
printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$PWD" \
  | node ~/.claude/hooks/secrets-guard.mjs; echo "exit=$?"
```

`[secrets-guard] 커밋 차단` 메시지와 `exit=2`가 나오면 정상.

## Claude Code 스킬로 쓰기

`install.mjs`를 돌리면 스킬이 `~/.claude/skills/secrets-guard/SKILL.md`에 들어간다. Claude Code에서 `/secrets-guard`를 치거나 "secrets guard 설치", "비밀 커밋 차단 점검"이라고 말하면 에이전트가 그 파일의 절차대로 설치·점검·오탐 해제를 진행한다.

## 오탐 대처

훅은 파일 전체를 스캔하므로, 걸리는 줄 하나가 그 파일을 건드리는 모든 커밋을 막는다. 훅이 아니라 그 줄을 고친다.

- **테스트 파일은 휴리스틱 패턴에 대해 차단이 아니라 경고.** `*.test.mjs` 안의 `process.env.SESSION_SECRET = "<32자짜리 더미 문자열>"` 같은 픽스처(이 규칙을 만들게 한 바로 그 사례)는 경고만 내고 커밋은 진행된다. 확정 키 형식은 테스트 파일이어도 차단되니, 테스트에 꼭 필요하면 형식을 깨라(이 저장소의 테스트처럼 문자열을 쪼개서 실행 시 조립).
- **더미 접두어는 무시** — 따옴표 휴리스틱에서 값이 `test-`, `test_`, `dummy`, `example`, `sample`, `fake`, `mock`, `stub`, `placeholder`, `changeme`, `your-`, `your_`, `xxx`, `foo`, `bar`로 시작하면 제외.
- **플레이스홀더는 무시** — 무따옴표 휴리스틱에서 `${VAR}`, `$(cmd)`, `<값>`, `changeme`, `your-`, `example`, `placeholder`, `xxx`, `none`, `null`, `true`, `false`, 그리고 16자 미만이거나 숫자가 없는 값은 제외.
- **산문**의 `ask-questions-about-…` 류는 잡히지 않는다. `sk-` 패턴은 앞에 단어 문자가 없어야 한다.
- 그래도 오탐이면 그 줄을 파일 밖으로 빼거나, `hooks/secrets-guard.mjs`의 `SECRET_PATTERNS`를 고치고 `npm test`를 통과시킨 뒤 다시 설치한다.

## 제한

- Bash / PowerShell 도구의 **명령 문자열**만 본다. `npm run release`, `./scripts/commit.sh`, Makefile 타깃처럼 래퍼 안에서 도는 커밋은 감지하지 못한다. 필요하면 저장소별 git `pre-commit` 훅을 같이 둔다.
- 정규식 기반이다. 모르는 형식의 비밀, 여러 줄에 쪼개지거나 인코딩된 비밀은 못 잡는다.
- 내용 검사는 파일당 앞 1MB, 명령당 최대 300개 파일. 파일명 규칙은 개수와 무관하게 전부 적용한다.
- 비인쇄 문자 비율이 30%를 넘는 파일은 바이너리로 보고 건너뛴다.
- PATH에 `git`이 있어야 하고 Node.js 20 이상이 필요하다.

## 개발

```
npm test        # node --test hooks/secrets-guard.test.mjs — 임시 git 저장소를 만들어 실제 훅 프로세스를 돌린다
```

## 라이선스

[MIT](LICENSE) © 2026 Youkamii
