#!/usr/bin/env node
// PreToolUse 훅: git add/commit 직전에 비밀(API 키·암호·토큰)이 들어가는지 검사해 차단한다.
//
// 존재 이유: 에이전트가 키/암호가 든 파일을 검사 없이 커밋해버리는 사고가 실제로 있었음 (2026-06 사용자 보고).
// 커밋된 비밀은 git 히스토리에 영구히 남고, 푸시되면 유출이다. 프롬프트(부탁)가 아니라 코드(집행)로 막는다.
//
// 입출력 계약 (Claude Code PreToolUse 훅):
//   stdin  — 도구 입력 JSON { tool_name, tool_input: { command }, cwd }
//   차단   — stderr에 사유 출력 + exit 2 (Claude Code가 도구 실행을 막고 사유를 모델에 보여준다)
//   경고   — stdout에 { hookSpecificOutput: { additionalContext } } + exit 0 (실행은 허용, 모델에게만 경고)
//   통과   — 출력 없이 exit 0
//
// 알려진 구조적 한계 (크로스벤더 감사 #3, 코드로 못 막음):
//   이 훅은 Bash/PowerShell '툴 명령 문자열'에서 git add/commit을 감지한다. 따라서 스크립트 래퍼
//   (`npm run release`, `./scripts/commit.sh` 등)가 내부에서 git commit을 호출하면 훅이 발화하지 않는다.
//   래퍼 커밋까지 막으려면 각 저장소에 git pre-commit 훅(다른 메커니즘)을 둬야 한다. 이 훅은 최전선이지 유일한 방어가 아니다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// [정규식, 라벨, 확정 여부]
//   firm: true  — 형식 자체가 비밀임을 확정하는 패턴(AWS AKIA…, GitHub ghp_…, 개인키 블록 등).
//                 테스트 파일이라도 항상 차단한다. 테스트에 진짜 형식의 키를 넣는 것 자체가 사고다.
//   firm: false — 변수명·문맥으로 추정하는 휴리스틱(password = "…" 류). 테스트 파일에서는 경고로 낮춘다.
const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key', true],
  // 선행 경계: "ask-...", "task-..." 같은 일반 단어 오탐 방지 (리뷰 발견 #7)
  [/(^|[^A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API Key', true],
  [/(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/, 'OpenAI류 API Key', true],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, 'GitHub Token', true],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub Fine-grained Token', true],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack Token', true],
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/, 'Slack App-Level Token', true],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API Key', true],
  [/\bya29\.[A-Za-z0-9_-]{20,}/, 'Google OAuth Access Token', true],
  // 결제·CI·레지스트리 토큰 (크로스벤더 감사 #5·#6 — prefix 고유해 오탐 위험 낮음)
  [/\b(sk|rk)_live_[A-Za-z0-9]{16,}/, 'Stripe Live Key', true],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab PAT', true],
  [/\bnpm_[A-Za-z0-9]{36}/, 'npm Access Token', true],
  [/\bhf_[A-Za-z0-9]{30,}/, 'HuggingFace Token', true],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인키(Private Key)', true],
  // DB 커넥션 스트링 속 암호 (user:pass@host). 테스트 픽스처에 로컬 DB용 더미 계정 URL이 흔해 휴리스틱으로 분류.
  [/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqps?):\/\/[^:@/\s]+:[^@/\s]{3,}@/i, 'DB 커넥션 스트링 내 암호', false],
  // 오탐 억제: 무따옴표 패턴(아래)과 대칭이 되도록 흔한 더미·플레이스홀더를 제외한다.
  // 테스트 코드의 accessToken: "test-token" 류가 진짜 토큰으로 잡히면 해당 파일을
  // 수정하는 모든 커밋이 영구히 막힌다 — 훅은 전체 파일 내용을 스캔하기 때문이다.
  [/(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'](?!test[-_]|dummy|example|sample|fake|mock|stub|placeholder|changeme|your[-_]|xxx|foo|bar)[^"'\s]{8,}["']/i, '하드코딩된 비밀값(따옴표)', false],
  // 무따옴표 설정값 (감사 #7). 오탐 억제: 16자 이상 + 숫자 포함 + 흔한 플레이스홀더/환경참조 제외
  [/(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*(?!["'\s]|\$\{|\$\(|<|changeme|your[-_]|example|placeholder|xxx|none\b|null\b|true\b|false\b)(?=[^\s"'#]*[0-9])[^\s"'#]{16,}/i, '하드코딩된 비밀값(무따옴표)', false],
];

// 테스트 파일 판정: *.test.* / *.spec.* / tests/ / __tests__/ 아래.
// 이유: 테스트는 "시크릿처럼 생긴 고정값"(세션 시크릿, 더미 암호)을 의도적으로 넣는 곳이라 휴리스틱 패턴의
// 오탐이 집중된다. 실제 사고 사례: 테스트의 process.env.SESSION_SECRET = "<32자짜리 더미 문자열>" 이
// '하드코딩된 비밀값(따옴표)'으로 잡혀 테스트 커밋이 막힘 (2026-10-08). 차단 대신 경고로 낮춰 모델이 판단하게 한다.
// (이 주석에 실제 더미값을 그대로 적으면 이 파일 자체가 같은 패턴에 걸린다 — 그래서 꺾쇠로 표기.)
// 단 firm 패턴(실제 키 형식)은 테스트 파일이어도 차단 — 형식이 맞는 키는 더미일 가능성이 낮고, 더미라면 형식을 깨면 된다.
const TEST_FILE_RE = /(^|\/)(tests|__tests__)\/|\.(test|spec)\.[^/]+$/;

// 내용과 무관하게 커밋 자체가 금지인 파일명 (.env.example 류 템플릿은 허용). 테스트 경로여도 예외 없음.
const FORBIDDEN_FILES = [
  { re: /(^|\/)\.env(\.(?!example|sample|template)[\w.-]+)?$/, why: '.env 파일 (환경변수/비밀 저장소)' },
  { re: /\.pem$/, why: '인증서/키 파일' },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)(\.|$)/, why: 'SSH 개인키' },
  { re: /\.(key|p12|pfx)$/, why: '키/인증서 파일' },
];

const MAX_FILES = 300;
const MAX_BYTES = 1024 * 1024;

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!['Bash', 'PowerShell'].includes(input.tool_name)) process.exit(0);
  const cmd = (input.tool_input && input.tool_input.command) || '';
  const gitIdx = cmd.search(/\bgit\b[^|;&]*\b(add|commit)\b/);
  if (gitIdx < 0) process.exit(0);

  // cd가 포함된 복합 명령이면 git이 실제로 도는 디렉터리를 추적한다 (리뷰 발견 #5)
  let cwd = input.cwd || process.cwd();
  const cdRe = /(?:^|&&|;)\s*cd\s+("([^"]*)"|'([^']*)'|[^\s;&|]+)/g;
  let m, dest = null;
  while ((m = cdRe.exec(cmd.slice(0, gitIdx))) !== null) dest = m[2] ?? m[3] ?? m[1];
  if (dest && dest !== '-') {
    let d = dest.replace(/^~(?=[\/\\]|$)/, os.homedir());
    const gb = /^\/([A-Za-z])(\/|$)/.exec(d); // git-bash 드라이브 표기 /c/... → C:/...
    if (gb) d = gb[1].toUpperCase() + ':' + d.slice(2);
    cwd = path.resolve(cwd, d);
  }

  const git = (...args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
    catch { return ''; }
  };

  // 검사 대상: 이미 스테이징된 파일 + (같은 명령에서 스테이징될) 변경/신규 파일.
  // 삭제 스테이징(--diff-filter=d 제외)은 검사하지 않는다 — 커밋된 .env를 git rm으로
  // 제거하는 정리 커밋까지 파일명 규칙으로 차단하면 유출 복구가 교착된다 (red-review C6).
  // git commit -a/-am/--all 도 add와 동급으로 작업 트리를 스캔한다 (리뷰 발견 #4)
  const files = new Set(git('diff', '--cached', '--name-only', '--diff-filter=d').split('\n').filter(Boolean));
  const hasAdd = /\bgit\b[^|;&]*\badd\b/.test(cmd);
  const commitAll =
    /\bgit\b[^|;&]*\bcommit\b/.test(cmd) && /(^|\s)(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(cmd);
  if (hasAdd || commitAll) {
    // add/commit -a 는 훅 시점엔 아직 실행 전이므로, 작업 트리의 변경·신규 파일을 함께 검사한다.
    // -z(NUL 구분)로 읽어 비ASCII 파일명 C-quoting 파싱 실패를 피한다 (감사 렌즈외 지적)
    for (const rec of git('status', '--porcelain', '-z').split('\0')) {
      if (!rec) continue;
      const mm = /^([ MADRCU?!]{2}) ([\s\S]*)$/.exec(rec);
      if (mm && mm[1].includes('D')) continue; // 삭제 예정 파일은 검사 제외 (위와 동일 사유)
      files.add(mm ? mm[2] : rec); // 리네임의 원경로 토큰은 XY 접두 없음 → 통째로 (존재 안 하면 스킵)
    }
  }

  const findings = []; // 차단 사유
  const warnings = []; // 경고(테스트 파일의 휴리스틱 탐지) — 실행은 허용
  // 파일명 검사는 전 파일 대상 — I/O 없이 싸고, 개수 상한에 걸려 .env 류가 새면 안 된다 (감사 #2)
  for (const f of files) {
    for (const rule of FORBIDDEN_FILES) {
      if (rule.re.test(f)) findings.push(`${f} — ${rule.why}`);
    }
  }
  // 내용 검사만 개수 상한 적용 (readFileSync가 I/O 비용)
  let checked = 0;
  for (const f of files) {
    if (checked >= MAX_FILES) break;
    const p = path.join(cwd, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    checked += 1;
    let content;
    try {
      if (st.size > MAX_BYTES) {
        // 1MB 초과 파일도 통째 스킵하지 않고 앞부분만 읽어 스캔한다 (감사 #4)
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(MAX_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
        fs.closeSync(fd);
        content = buf.subarray(0, n).toString('utf8');
      } else {
        content = fs.readFileSync(p, 'utf8');
      }
    } catch { continue; }
    // 바이너리 판별: 제어문자(탭·개행 제외) 비율이 높으면 진짜 바이너리로 보고 스킵.
    // 산발적 널바이트(텍스트에 1~2개 주입)는 제거 후 스캔한다 — 널바이트 1개로 전체 스캔을
    // 무력화하던 우회 차단 (감사 #1). 밀도가 아니라 인쇄가능 비율로 판정해 짧은 파일 오판을 막는다.
    const nonText = (content.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
    if (content.length && nonText / content.length > 0.3) continue; // 진짜 바이너리
    if (content.includes('\0')) content = content.replace(/\0/g, '');
    const isTest = TEST_FILE_RE.test(f);
    for (const [re, label, firm] of SECRET_PATTERNS) {
      if (!re.test(content)) continue;
      if (isTest && !firm) warnings.push(`${f} — ${label} 패턴 발견 (테스트 파일이라 경고만)`);
      else findings.push(`${f} — ${label} 패턴 발견`);
    }
  }

  if (findings.length) {
    console.error(
      `[secrets-guard] 커밋 차단 — 비밀로 보이는 내용이 포함됩니다:\n` +
        [...new Set(findings)].map((x) => `  - ${x}`).join('\n') +
        (warnings.length ? `\n경고(차단 아님):\n` + [...new Set(warnings)].map((x) => `  - ${x}`).join('\n') : '') +
        `\n조치: 비밀값을 .env 로 옮기고 .env 를 .gitignore 에 추가한 뒤 다시 커밋하라. ` +
        `오탐(예시 문자열 등)이라면 해당 줄을 분리하거나 사용자에게 확인을 받아라.`
    );
    process.exit(2);
  }
  if (warnings.length) {
    // 차단은 아니지만 모델에게 알린다 — 테스트 파일의 값이 진짜 비밀이면 모델이 멈춰야 한다.
    process.stdout.write(
      JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext:
            `[secrets-guard] 경고 — 테스트 파일에서 비밀로 보이는 값이 발견됐으나 차단하지 않았다: ` +
            [...new Set(warnings)].join('; ') +
            `. 더미 값이면 그대로 진행하고, 실제 비밀이라면 커밋을 중단하고 .env 로 옮겨라.`,
        },
      })
    );
  }
  process.exit(0);
});
