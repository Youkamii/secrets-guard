# secrets-guard

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-24%20passing-brightgreen.svg)](hooks/secrets-guard.test.mjs)
[![Claude Code hook](https://img.shields.io/badge/Claude%20Code-PreToolUse%20hook-8A2BE2.svg)](#install)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

A Claude Code `PreToolUse` hook that stops the agent from running `git add` / `git commit` when the files about to be committed contain API keys, passwords, tokens or `.env` files.

[한국어 README](README.ko.md)

Why: an agent once committed a file with real credentials without looking. A committed secret stays in git history forever, and one push makes it a leak. A prompt is a request; a hook is enforcement. This hook enforces.

## What it does

Before every Bash / PowerShell tool call whose command contains `git add` or `git commit`, the hook:

1. Collects the files that will end up in the commit: already-staged files, plus the working tree for `git add` and `git commit -a/-am`. Deletions are skipped so a clean-up commit that removes a leaked `.env` is never blocked.
2. Checks file names against a forbidden list.
3. Scans file contents (first 1 MB, up to 300 files) against secret patterns.
4. If anything matches, prints the reason to stderr and exits with code 2, which makes Claude Code refuse the tool call and show the reason to the model.

It follows `cd` in compound commands (`cd ../other && git commit`), reads file names NUL-separated so non-ASCII names work, and strips stray NUL bytes so a single `\0` cannot disable the scan.

## What is blocked, what is warned

| Category | Patterns | Regular file | Test file* |
|---|---|---|---|
| Definite key formats | AWS `AKIA…` · Anthropic `sk-ant-…` · OpenAI-style `sk-…` · GitHub `ghp_/gho_/ghu_/ghs_/ghr_` and `github_pat_` · Slack `xox[baprs]-` and `xapp-` · Google `AIza…` and `ya29.` · Stripe `sk_live_/rk_live_` · GitLab `glpat-` · npm `npm_` · HuggingFace `hf_` · `-----BEGIN … PRIVATE KEY-----` | **Block** | **Block** |
| Heuristics | `password / passwd / secret / api_key / access_token / auth_token` `= "value"` (quoted, 8+ chars) or unquoted (16+ chars with a digit) · DB connection URLs with `user:pass@` (`postgres`, `mysql`, `mongodb`, `redis`, `amqp`) | **Block** | **Warn only** |
| Forbidden file names | `.env` and `.env.*` (except `.env.example`, `.env.sample`, `.env.template`) · `*.pem` · `id_rsa`, `id_ed25519`, `id_ecdsa` · `*.key`, `*.p12`, `*.pfx` | **Block** | **Block** |

\* Test file = path matching `*.test.*`, `*.spec.*`, `tests/`, `__tests__/`.

A warning does not stop the command. It is injected as `additionalContext` for the model with the file name and pattern, so the model can stop on its own if the value turns out to be real.

## Install

**1. Copy the files.**

```
git clone https://github.com/Youkamii/secrets-guard.git
cd secrets-guard
node install.mjs
```

This copies `hooks/secrets-guard.mjs` to `~/.claude/hooks/` and `skills/secrets-guard/SKILL.md` to `~/.claude/skills/secrets-guard/`, then prints the settings snippet for your machine. (Manual copy works just as well.)

**2. Register the hook** in `~/.claude/settings.json` (or a project's `.claude/settings.json`). Use the absolute path for your machine; forward slashes are fine on Windows.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/home/you/.claude/hooks/secrets-guard.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`node install.mjs --write-settings` merges this into `~/.claude/settings.json` for you and leaves a backup at `settings.json.bak-secrets-guard`. Restart Claude Code afterwards; hooks are read at session start.

**3. Verify.**

```
node install.mjs --check
```

Or feed the hook a fake tool call from inside a scratch repository with a staged file that trips the unquoted heuristic (16+ characters with a digit):

```
git init scratch && cd scratch
echo "password: $(date +%s)-not-a-real-secret" > cfg.yaml && git add cfg.yaml
printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$PWD" \
  | node ~/.claude/hooks/secrets-guard.mjs; echo "exit=$?"
```

Expected: a `[secrets-guard] 커밋 차단` message and `exit=2`.

## Use it as a Claude Code skill

After `install.mjs` the skill lives at `~/.claude/skills/secrets-guard/SKILL.md`. Type `/secrets-guard` in Claude Code, or say "install secrets guard" / "secrets guard 점검", and the agent walks through install, check and false-positive handling using the procedure in that file.

## False positives

The hook scans whole files, so one matching line blocks every future commit that touches the file. Fix the line rather than the hook.

- **Test files are warned, not blocked** for heuristic patterns. A fixture such as `process.env.SESSION_SECRET = "<32-character dummy string>"` in `*.test.mjs` (the exact case that motivated this rule) produces a warning and the commit proceeds. Definite key formats are still blocked in test files; if you need one in a test, break the format (split the string and join it at runtime, as this repository's own tests do).
- **Dummy prefixes are ignored** in the quoted heuristic: values starting with `test-`, `test_`, `dummy`, `example`, `sample`, `fake`, `mock`, `stub`, `placeholder`, `changeme`, `your-`, `your_`, `xxx`, `foo`, `bar`.
- **Placeholders are ignored** in the unquoted heuristic: `${VAR}`, `$(cmd)`, `<value>`, `changeme`, `your-`, `example`, `placeholder`, `xxx`, `none`, `null`, `true`, `false`, and anything shorter than 16 characters or without a digit.
- **Prose** such as `ask-questions-about-…` is not matched; the `sk-` patterns require a non-word boundary before them.
- Still a false positive? Move the line out of the file, or adjust `SECRET_PATTERNS` in `hooks/secrets-guard.mjs`, run `npm test`, and reinstall.

## Limits

- It only sees the **command string** of the Bash / PowerShell tool. A commit made inside a wrapper (`npm run release`, `./scripts/commit.sh`, a Makefile target) is not detected. Pair it with a per-repository git `pre-commit` hook if you need that.
- Regex based. Unknown secret formats, and secrets split across lines or encoded, are not caught.
- Content scan reads the first 1 MB of each file and at most 300 files per command. File-name rules apply to every file regardless.
- Files whose non-printable character ratio exceeds 30% are treated as binary and skipped.
- Requires `git` on PATH and Node.js 20+.

## Development

```
npm test        # node --test hooks/secrets-guard.test.mjs — spins up temporary git repos and runs the real hook
```

## License

[MIT](LICENSE) © 2026 Youkamii
