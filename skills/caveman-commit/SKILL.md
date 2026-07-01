---
name: caveman-commit
description: >
  Caveman Conventional Commit writer. Use when the user asks to commit, requests a commit
  message, invokes /commit or /caveman-commit, stages changes, or another workflow needs
  a commit message.
---

# Caveman Commit

Tight Conventional Commits from evidence. Why over what. No fluff.

## Steps

1. Read intent + convention.
   - Check user request, supplied issue/PR context, `git status --short`, and recent style with `git log -5 --pretty=%s` when in a repo.
   - Done when type/scope/capitalization convention is known or absent.

2. Inspect the diff.
   - Prefer staged changes: `git diff --cached --stat` then `git diff --cached`.
   - If nothing staged and user only wants a message, inspect `git diff`.
   - If user asked to commit and nothing is staged, do not stage unless explicitly asked; report no staged changes.
   - Done when every changed logical unit is understood, including tests/docs/config.

3. Shape the subject.
   - Format: `<type>(<scope>)!: <imperative summary>`; scope and `!` only when earned.
   - Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`.
   - Imperative mood: `add`, `fix`, `remove`; not `added`, `adds`, `adding`.
   - ≤50 chars when possible; hard cap 72. No trailing period.
   - If the diff has unrelated units, recommend splitting instead of hiding it behind a vague subject.
   - Done when the subject is specific, typed, and convention-compatible.

4. Decide body.
   - Omit body when the subject is enough.
   - Require body for breaking changes, security fixes, data/schema migrations, reverts, operational impact, linked issues, or non-obvious why.
   - Never invent why. If required context is missing, ask before finalizing.
   - Wrap body at 72 chars. Use `-` bullets. Put issue refs/trailers last.
   - Done when body is either absent or contains only evidence-backed context future debuggers need.

5. Output or commit.
   - If user asked for a message, output only a paste-ready code block.
   - If user explicitly asked to commit, use the final message for `git commit` after the message passes this skill.
   - Done when no extra prose leaks into the message.

## Caveman bans

- `This commit ...`, `I`, `we`, `now`, `currently`; the diff says what.
- AI attribution, unless the repo/user requires it as a trailer.
- Emoji, unless repo convention uses it.
- File-name restatement when scope already names the area.
- `Co-authored-by` unless there is a real co-author.

## Required trailers/forms

- Breaking change: subject uses `!` and body contains `BREAKING CHANGE: ...`.
- Issues: `Closes #42`, `Refs #17` at the end.
- Reverts: explain what is reverted and why the revert is needed.
