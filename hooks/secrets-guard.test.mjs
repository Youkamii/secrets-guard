// secrets-guard.mjs 회귀 테스트 — 임시 git 레포를 만들어 실제 훅 프로세스를 돌린다.
// 실행: node --test hooks/secrets-guard.test.mjs   (또는 npm test)
// 주의: 테스트용 가짜 키는 자기 자신이 커밋될 때 오탐되지 않도록 문자열을 쪼개서 조립한다.
//       (이 파일은 *.test.* 라서 휴리스틱 패턴은 경고로 낮춰지지만, 확정 키 형식은 여전히 차단된다.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'secrets-guard.mjs');
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'; // 조립: 소스 자체가 패턴에 안 걸리게
const FAKE_GH = 'ghp' + '_' + 'A'.repeat(34);
const FAKE_STRIPE = 'sk' + '_live_' + 'a'.repeat(24);
const FAKE_GLPAT = 'glpat' + '-' + 'A'.repeat(20);
const SECRET_VAL = 'super' + 'secret' + 'value' + '123';
const DB_URL = 'postgres' + '://admin:' + 'pwlongsecret99' + '@db.host:5432/app';
const FAKE_PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----';
// 2026-10-08 오탐 사례의 재현값. 소스에서는 조립 + JSON.stringify 로 넣어 이 파일 자체가 따옴표 패턴에 안 걸리게 한다.
const SESSION_DUMMY = 'cli-session-' + 'secret-with-32-characters!!';

const run = (command, cwd, tool_name = 'Bash') =>
  spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name, tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const dirs = [];
const mkrepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  dirs.push(d);
  return d;
};
const write = (d, rel, content) => {
  const p = path.join(d, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const parseWarn = (r) => {
  // 경고는 stdout JSON { hookSpecificOutput: { additionalContext } } 로 나온다
  if (!r.stdout) return null;
  return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? null;
};

after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ── 기본 차단 ──
test('스테이징된 AWS 키 차단 (파일에 공백 있어도 바이너리로 오판 안 함)', () => {
  const d = mkrepo();
  write(d, 'config.py', `aws key = "${FAKE_AWS}"\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /AWS Access Key/);
});

test('git commit -am 이 새로 넣는 비밀 차단 (리뷰 발견 #4)', () => {
  const d = mkrepo();
  write(d, 'a.txt', 'clean\n');
  git(d, 'add', '.');
  git(d, 'commit', '-qm', 'init');
  write(d, 'a.txt', `token = "${FAKE_GH}"\n`);
  const r = run('git commit -am update', d);
  assert.equal(r.status, 2, r.stderr);
});

test('cd <다른레포> && commit — 실제 대상 레포를 검사 (리뷰 발견 #5)', () => {
  const outer = mkrepo();
  const inner = mkrepo();
  write(inner, 's.txt', `x = "${FAKE_AWS}"\n`);
  git(inner, 'add', '.');
  const r = run(`cd "${inner}" && git commit -m x`, outer);
  assert.equal(r.status, 2, r.stderr);
});

test('PowerShell 도구도 동일하게 검사', () => {
  const d = mkrepo();
  write(d, 'x.txt', `k=${FAKE_AWS}\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d, 'PowerShell');
  assert.equal(r.status, 2, r.stderr);
});

test('Bash/PowerShell 외 도구는 무개입', () => {
  const d = mkrepo();
  write(d, 'x.txt', `k=${FAKE_AWS}\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d, 'Read');
  assert.equal(r.status, 0);
});

// ── 오탐 방지 ──
test('산문 속 ask-... 오탐 금지 (리뷰 발견 #7)', () => {
  const d = mkrepo();
  write(d, 'notes.md', 'please ask-questions-about-the-architecture-here thanks\n');
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 0, r.stderr);
});

test('.env 파일명 차단 / .env.example 허용', () => {
  const d = mkrepo();
  write(d, '.env', 'X=1\n');
  write(d, '.env.example', 'X=\n');
  git(d, 'add', '-f', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\.env —/);
  assert.doesNotMatch(r.stderr, /\.env\.example/);
});

test('git 무관 명령은 무개입', () => {
  const d = mkrepo();
  const r = run('ls -la', d);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '');
});

test('플레이스홀더(env 참조·changeme·your-)는 통과', () => {
  const d = mkrepo();
  write(d, 'sample.yaml', `password: \${DB_PASSWORD}\nsecret: changeme\napi_key: your-key-here\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 0, r.stderr);
});

test('따옴표 더미값(test-/dummy/example 등)은 일반 파일에서도 통과', () => {
  const d = mkrepo();
  write(d, 'fixture.js', `const accessToken = "test-token-abcdef";\nconst password = "dummy-password";\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 0, r.stderr);
});

// ── Phase 2 강화 (크로스벤더 red-review 재현본) ──
test('널바이트 삽입해도 AWS 키 탐지 (감사 #1)', () => {
  const d = mkrepo();
  write(d, 'note.txt', `x=${FAKE_AWS}\0trailing\n`);
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('Stripe 라이브 키 차단 (감사 #5)', () => {
  const d = mkrepo();
  write(d, 'pay.js', `const k = "${FAKE_STRIPE}"\n`);
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('GitLab PAT 차단 (감사 #6)', () => {
  const d = mkrepo();
  write(d, 'ci.yml', `token: ${FAKE_GLPAT}\n`);
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('무따옴표 password 차단 (감사 #7)', () => {
  const d = mkrepo();
  write(d, 'app.yaml', `password: ${SECRET_VAL}\n`);
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('대용량 파일(1MB 초과) 앞부분 비밀 탐지 (감사 #4)', () => {
  const d = mkrepo();
  write(d, 'big.log', `key=${FAKE_AWS}\n` + 'x'.repeat(1024 * 1024 + 10));
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('DB 커넥션 스트링 내 암호 차단 (감사 #6)', () => {
  const d = mkrepo();
  write(d, 'db.txt', DB_URL + '\n');
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});

test('이미 커밋된 .env 를 제거하는 정리 커밋은 통과 (red-review C6)', () => {
  const d = mkrepo();
  write(d, '.env', 'X=1\n');
  git(d, 'add', '-f', '.env');
  git(d, 'commit', '-qm', 'oops'); // 임시 레포엔 훅 미설치 — 실수 커밋 재현
  git(d, 'rm', '-q', '.env');
  const r = run('git commit -m "remove leaked env"', d);
  assert.equal(r.status, 0, r.stderr);
});

test('삭제+신규 비밀 혼합 시 신규는 차단 (commit -am 경로)', () => {
  const d = mkrepo();
  write(d, '.env', 'X=1\n');
  write(d, 'ok.txt', 'clean\n');
  git(d, 'add', '-f', '.');
  git(d, 'commit', '-qm', 'init');
  git(d, 'rm', '-q', '.env');
  write(d, 'ok.txt', `k = "${FAKE_AWS}"\n`);
  const r = run('git commit -am cleanup', d);
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /\.env —/);
});

// ── 테스트 파일 규칙 (2026-10-08 오탐: SESSION_SECRET 더미값이 테스트 커밋을 막음) ──
test('테스트 파일(*.test.*)의 휴리스틱 패턴은 차단 대신 경고', () => {
  const d = mkrepo();
  // 실제 오탐 재현: 따옴표 비밀값 패턴에 걸리는 세션 시크릿 더미
  write(d, 'cli.test.mjs', `process.env.SESSION_SECRET = ${JSON.stringify(SESSION_DUMMY)};\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 0, r.stderr);
  const warn = parseWarn(r);
  assert.ok(warn, 'stdout에 additionalContext 경고가 있어야 함: ' + r.stdout);
  assert.match(warn, /cli\.test\.mjs/);
  assert.match(warn, /하드코딩된 비밀값\(따옴표\)/);
});

test('tests/ · __tests__/ · *.spec.* 경로도 테스트 파일로 취급', () => {
  for (const rel of ['tests/db.txt', '__tests__/cfg.yaml', 'src/auth.spec.ts']) {
    const d = mkrepo();
    write(d, rel, `password: ${SECRET_VAL}\n${DB_URL}\n`);
    git(d, 'add', '.');
    const r = run('git commit -m x', d);
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    assert.ok(parseWarn(r), `${rel}: 경고가 있어야 함`);
  }
});

test('테스트 파일이라도 확정 키 형식(AWS·GitHub·개인키)은 계속 차단', () => {
  const cases = [
    ['aws.test.js', `const k = "${FAKE_AWS}";\n`, /AWS Access Key/],
    ['tests/gh.txt', `token=${FAKE_GH}\n`, /GitHub Token/],
    ['__tests__/key.spec.ts', `const pem = \`${FAKE_PEM}\`;\n`, /개인키/],
  ];
  for (const [rel, content, label] of cases) {
    const d = mkrepo();
    write(d, rel, content);
    git(d, 'add', '.');
    const r = run('git commit -m x', d);
    assert.equal(r.status, 2, `${rel}: 차단돼야 함`);
    assert.match(r.stderr, label);
  }
});

test('테스트 파일의 경고 + 일반 파일의 차단이 섞이면 차단하고 경고도 함께 표시', () => {
  const d = mkrepo();
  write(d, 'a.test.js', `password = ${JSON.stringify(SECRET_VAL)}\n`);
  write(d, 'prod.yaml', `password: ${SECRET_VAL}\n`);
  git(d, 'add', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /prod\.yaml/);
  assert.match(r.stderr, /경고\(차단 아님\)[\s\S]*a\.test\.js/);
});

test('테스트 경로의 .env 파일명 규칙은 예외 없이 차단', () => {
  const d = mkrepo();
  write(d, 'tests/.env', 'X=1\n');
  git(d, 'add', '-f', '.');
  const r = run('git commit -m x', d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tests\/\.env/);
});

test('"testing.md" 같은 이름은 테스트 파일로 오인하지 않음', () => {
  const d = mkrepo();
  write(d, 'docs/testing.md', `password: ${SECRET_VAL}\n`);
  git(d, 'add', '.');
  assert.equal(run('git commit -m x', d).status, 2);
});
