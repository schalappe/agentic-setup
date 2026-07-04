# Agentic Setup

Personal setup for the Pi coding agent: extensions, skills, and themes kept in one repo.

## Contents

| Path | Purpose |
| --- | --- |
| `extensions/` | Custom Pi extensions and tools. |
| `skills/` | Reusable agent skills. |
| `themes/` | Local Pi themes. |

## Extensions

- `agent-rules.ts` — exposes global and project agent rules to sessions.
- `ask-user.ts` — adds a multiple-choice `ask_user` tool.
- `border-editor.ts` — custom editor border/status UI.
- `flow-title.ts` — custom startup/title screen.
- `feature-loop/` — starts GitHub issue feature and PR review loops.
- `github-issue-autocomplete.ts` — autocompletes GitHub issue references with `#...`.
- `goal-mode/` — persistent `/goal` loop with budget, guided setup, and auto-child delegation.
- `openai-codex-fast-mode.ts` — sets OpenAI Codex requests to priority service tier.
- `sound-notification.ts` — plays a sound when the agent finishes.
- `todo.ts` — adds session-scoped todo tools and UI.
- `truncated-tools.ts` — adds truncation-safe `rg` search.
- `web-tools/` — adds `webfetch` and `websearch`; see `extensions/web-tools/README.md`.

## Skills

- `agent-ready-issue` — write GitHub issues an agent can implement without guessing.
- `caveman-comments` — compress comments/docstrings without losing contracts.
- `caveman-commit` — write terse Conventional Commit messages.
- `loop-engineering` — design small autonomous agent loops.
- `writing-adrs` — write architecture decision records.

## Themes

Included themes:

- `andromeda`
- `gruvbox-dark-hard`
- `monochromator-dark-amber`
- `monochromator-dark-emerald`
- `nebula-oni-cerberus`
- `night-owl`
- `rose-pine-dawn`
- `rose-pine-moon`

## License

MIT
