# Goal Mode Extension

Persistent autonomous goal mode for Pi.

## Commands

- `/goal <objective>` — start goal mode.
- `/goal set <objective>` — replace/start goal.
- `/goal show` — show objective, status, budget, child mode.
- `/goal pause` / `/goal resume` — stop/restart autonomous continuation.
- `/goal drop` — discard goal without completion.
- `/goal budget <N|off>` — set/clear token budget.
- `/goal child <on|off>` — let main agent use `subagent` automatically when useful.
- `/guided-goal <rough objective>` — model-guided interview, then start.

## Child agents

This extension does not spawn children by heuristic. It enables the `subagent` tool when loaded and tells the main agent to delegate when isolated scouting, review, parallel investigation, or separate implementation helps. Parent keeps completion authority.

Load `extensions/subagent/` too for child support.

## Install

Symlink directory into Pi extensions:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/agentic-setup/extensions/goal-mode ~/.pi/agent/extensions/goal-mode
```

Then run `/reload`.
