---
name: secrets-guard
description: Claude Code PreToolUse 훅 secrets-guard의 설치·점검·오탐 해제. 에이전트가 API 키·암호·토큰·.env 파일을 git add/commit 하려 할 때 코드로 차단한다. 트리거 — "비밀 커밋 차단", "secrets guard 설치", "secrets guard 점검", "secrets-guard 오탐", "커밋이 secrets-guard에 막혔다", "install secrets guard".
---

# secrets-guard — 비밀 커밋 차단 훅

`git add` / `git commit`(Bash·PowerShell 도구) 직전에 스테이징될 파일을 스캔해 비밀로 보이는 내용이 있으면 **exit 2로 명령을 막는다**. 프롬프트가 아니라 훅(코드)이 집행하므로 모델이 깜빡해도 막힌다.

원본 저장소: https://github.com/Youkamii/secrets-guard

## 1. 설치

사용자가 "설치해줘"라고 하면 아래 순서로 진행한다. 이미 설치돼 있으면 2번(점검)으로 간다.

1. 저장소를 받는다 (이미 있으면 생략).
   ```
   git clone https://github.com/Youkamii/secrets-guard.git
   ```
2. 설치 스크립트를 돌린다. 훅을 `~/.claude/hooks/secrets-guard.mjs`, 이 스킬을 `~/.claude/skills/secrets-guard/SKILL.md`로 복사하고 settings.json 스니펫을 출력한다.
   ```
   node install.mjs
   ```
   settings.json 자동 병합을 원하면 `node install.mjs --write-settings` (백업 `settings.json.bak-secrets-guard` 생성). 사용자 설정 파일을 고치는 일이므로 사용자가 명시하지 않았으면 스니펫만 보여주고 직접 붙이게 한다.
3. `~/.claude/settings.json`의 `hooks.PreToolUse`에 다음이 들어 있는지 확인한다 (경로는 절대 경로, 슬래시 사용).
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|PowerShell",
           "hooks": [
             { "type": "command", "command": "node \"/home/you/.claude/hooks/secrets-guard.mjs\"", "timeout": 10 }
           ]
         }
       ]
     }
   }
   ```
4. Claude Code를 재시작한다 (settings.json의 훅은 세션 시작 시 읽힌다).

## 2. 점검

```
node install.mjs --check          # 파일 존재 + settings.json 등록 여부
npm test                          # 저장소 안에서: 회귀 테스트 24건
```

실제 동작 확인(임시 저장소에서, 실제 비밀은 쓰지 않는다):
```
git init scratch && cd scratch
echo "password: $(date +%s)-not-a-real-secret" > cfg.yaml && git add cfg.yaml
printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$PWD" | node ~/.claude/hooks/secrets-guard.mjs; echo "exit=$?"
```
exit 2와 `[secrets-guard] 커밋 차단` 메시지가 나와야 한다.

## 3. 무엇을 막고 무엇을 경고하는가

| 종류 | 예 | 일반 파일 | 테스트 파일* |
|---|---|---|---|
| 확정 키 형식 | AWS `AKIA…`, GitHub `ghp_`/`github_pat_`, Anthropic/OpenAI `sk-…`, Slack `xox…`, Google `AIza…`/`ya29.`, Stripe `sk_live_`, GitLab `glpat-`, npm `npm_`, HuggingFace `hf_`, `-----BEGIN … PRIVATE KEY-----` | 차단 | 차단 |
| 휴리스틱 | `password/secret/api_key/access_token = "…"`(따옴표·무따옴표), DB URL 속 `user:pass@` | 차단 | **경고만** |
| 금지 파일명 | `.env`(`.env.example/.sample/.template` 제외), `*.pem`, `id_rsa`류, `*.key/.p12/.pfx` | 차단 | 차단 |

\* 테스트 파일 = `*.test.*`, `*.spec.*`, `tests/`, `__tests__/` 아래.

## 4. 오탐 해제 절차

커밋이 막혔을 때 **훅을 끄거나 우회하지 않는다.** 아래 순서로.

1. 차단 메시지에서 파일과 라벨을 읽는다. 라벨이 "확정 키 형식"이면 더미여도 형식을 깨라(예: `AKIA` 대신 `AKIA-EXAMPLE-`처럼 길이를 바꾸거나 문자열을 쪼개 조립).
2. 휴리스틱 라벨(하드코딩된 비밀값·DB 커넥션)이고 값이 더미라면:
   - 값 앞에 `test-`, `dummy`, `example`, `sample`, `fake`, `mock`, `stub`, `placeholder`, `changeme`, `your-`, `xxx` 중 하나를 붙이면 따옴표 패턴에서 제외된다.
   - 무따옴표 패턴은 `${VAR}`·`$(…)`·`<…>` 같은 환경 참조/플레이스홀더면 제외된다.
   - 테스트 파일이라면 이미 경고로만 나온다. 경고가 떴다면 값이 진짜 비밀이 아닌지 한 번 확인하고 진행한다.
3. 값이 진짜 비밀이면 `.env`로 옮기고 `.gitignore`에 `.env`를 넣은 뒤 다시 커밋한다. 이미 커밋된 `.env`를 `git rm`으로 지우는 정리 커밋은 막히지 않는다.
4. 그래도 오탐이면 사용자에게 보고하고 확인을 받는다. 패턴 수정은 저장소의 `hooks/secrets-guard.mjs` `SECRET_PATTERNS`에서 하고, `npm test`를 통과시킨 뒤 `node install.mjs`로 재설치한다.

## 5. 한계 (알고 쓰기)

- Bash/PowerShell 도구의 **명령 문자열**에서 `git add|commit`을 찾는다. `npm run release`, `./scripts/commit.sh`처럼 래퍼 안에서 도는 커밋은 감지하지 못한다. 그런 경우는 저장소별 git pre-commit 훅을 따로 둔다.
- 스캔은 파일당 앞 1MB, 내용 검사는 300개 파일까지. 파일명 규칙은 개수 제한 없이 전부 적용한다.
- 정규식 기반이라 모르는 형식의 비밀은 잡지 못한다.
