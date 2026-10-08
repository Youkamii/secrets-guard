#!/usr/bin/env node
// 설치 도우미: 훅과 스킬을 ~/.claude/ 아래로 복사하고, settings.json에 넣을 PreToolUse 항목을 출력한다.
//
//   node install.mjs                  훅·스킬 복사 + settings.json 스니펫 출력 (settings.json은 건드리지 않음)
//   node install.mjs --write-settings 위에 더해 ~/.claude/settings.json 에 PreToolUse 항목을 병합 (백업 생성)
//   node install.mjs --check          복사·등록 상태만 점검
//
// settings.json 자동 병합은 선택이다 — 기본은 스니펫만 출력해서 사용자가 직접 붙이게 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOK_SRC = path.join(HERE, 'hooks', 'secrets-guard.mjs');
const HOOK_DST = path.join(CLAUDE_DIR, 'hooks', 'secrets-guard.mjs');
const SKILL_SRC = path.join(HERE, 'skills', 'secrets-guard', 'SKILL.md');
const SKILL_DST = path.join(CLAUDE_DIR, 'skills', 'secrets-guard', 'SKILL.md');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

const args = new Set(process.argv.slice(2));
const hookPath = HOOK_DST.split(path.sep).join('/'); // settings.json 안에서는 슬래시가 OS 불문 안전
const hookEntry = { type: 'command', command: `node "${hookPath}"`, timeout: 10 };
const snippet = {
  hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [hookEntry] }] },
};

const readSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; }
};
const isRegistered = (s) =>
  !!s?.hooks?.PreToolUse?.some((g) =>
    (g.hooks || []).some((h) =>
      (h.command && h.command.includes('secrets-guard.mjs')) ||
      (Array.isArray(h.args) && h.args.some((a) => String(a).includes('secrets-guard.mjs')))));

if (args.has('--check')) {
  const s = readSettings();
  console.log(`hook   ${fs.existsSync(HOOK_DST) ? 'OK ' : 'MISSING'}  ${HOOK_DST}`);
  console.log(`skill  ${fs.existsSync(SKILL_DST) ? 'OK ' : 'MISSING'}  ${SKILL_DST}`);
  console.log(`settings.json PreToolUse 등록: ${s ? (isRegistered(s) ? 'OK' : 'MISSING') : '파일 없음/파싱 실패'}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(HOOK_DST), { recursive: true });
fs.mkdirSync(path.dirname(SKILL_DST), { recursive: true });
fs.copyFileSync(HOOK_SRC, HOOK_DST);
fs.copyFileSync(SKILL_SRC, SKILL_DST);
console.log(`복사됨: ${HOOK_DST}`);
console.log(`복사됨: ${SKILL_DST}`);

if (args.has('--write-settings')) {
  const s = readSettings() ?? {};
  if (isRegistered(s)) {
    console.log('settings.json: 이미 등록돼 있어 변경하지 않음');
  } else {
    if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.bak-secrets-guard');
    s.hooks ??= {};
    s.hooks.PreToolUse ??= [];
    const group = s.hooks.PreToolUse.find((g) => g.matcher === 'Bash|PowerShell');
    if (group) (group.hooks ??= []).push(hookEntry);
    else s.hooks.PreToolUse.push(snippet.hooks.PreToolUse[0]);
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    console.log(`settings.json 갱신됨 (백업: ${SETTINGS}.bak-secrets-guard)`);
  }
} else {
  console.log('\nsettings.json 의 "hooks" 에 아래를 추가하세요 (또는 --write-settings 로 자동 병합):\n');
  console.log(JSON.stringify(snippet, null, 2));
}
console.log('\n확인: node install.mjs --check');
