---
name: agent-ready-issue
description: Write agent-ready GitHub issues or briefs for implementation; use when creating, triaging, splitting, or refining issues for an AFK coding agent, or when another skill needs issue-body rules.
---

# Agent-Ready Issue

Write GitHub issues as implementation contracts an AFK coding agent can complete without guessing.

## Steps

1. **Pin the contract.** Identify category (`bug` or `enhancement`), current behavior, desired behavior, key interface contracts, acceptance criteria, and out-of-scope boundaries. Done when no required field is unknown; if a required field is unknowable from context, mark the issue `needs-info` instead of inventing it.

2. **Write behavioral, durable text.** State what the system should do, not which files to edit. Name stable contracts (`TypeName`, command, API, config shape) when useful. Avoid file paths, line numbers, and procedural implementation steps. Done when the issue still makes sense after a refactor or rename.

3. **Gate for agent-readiness.** The issue is ready only when every acceptance criterion is testable, edge/error behavior is covered where relevant, and out-of-scope blocks obvious gold-plating. If any gate fails, keep drafting or ask for the missing decision.

## Template

```markdown
**Category:** bug / enhancement
**Summary:** one-line implementation outcome

**Current behavior:**
What happens now. For bugs, include the broken behavior and reproduction if known.

**Desired behavior:**
What should happen after implementation, including relevant edge/error behavior.

**Key interfaces:**
- `TypeName` / `command` / `API` / config shape — contract change and why
- Use "None known" only when no stable interface is known yet

**Acceptance criteria:**
- [ ] Specific, independently testable criterion
- [ ] Specific, independently testable criterion
- [ ] Specific, independently testable criterion

**Out of scope:**
- Adjacent change this issue must not include
- Follow-up work handled elsewhere
```

## Smells

- “Fix the bug” with no current/desired behavior.
- “Update `path/to/file.ts` line 42” instead of naming a contract.
- Acceptance criteria that say “works correctly”.
- No out-of-scope section on a broad feature.
- Multiple unrelated outcomes in one issue; split into tracer-bullet issues first.
