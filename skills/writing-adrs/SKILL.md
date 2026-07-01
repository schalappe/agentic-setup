---
name: writing-adrs
description: ADR writing for architecture decision records. Use when the user wants to create, update, supersede, reject, or review an ADR; mentions architecture decision record; or another skill needs to record an architectural decision.
---

# Writing ADRs

Write ADRs as decision memory for future humans and agents. The ADR must answer: **why is the system this way, and what breaks if we change it?**

## Steps

### 1. Gate the ADR

Write an ADR only when the decision is architecturally significant: it constrains future work, is costly to reverse, had real alternatives, or carries context not visible in code.

Skip minor implementation choices, package bumps, obvious local changes, and decisions one engineer can safely make in one PR without future readers caring. If the user explicitly asks for an ADR anyway, write it but keep it tiny.

Done when the decision is either accepted as ADR-worthy or deliberately reduced to no ADR.

### 2. Find the archive

Use the repo's existing ADR location and naming. If none exists, use `docs/adr/0001-short-title.md`. Number sequentially and monotonically; never reuse numbers.

Never delete ADRs. Change `Status` instead: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or `Superseded by ADR-NNN`.

Done when the target file path and status are known.

### 3. Gather the forces

Collect only context that explains the decision:

- technical, product, team, political, social, compliance, vendor, and incident constraints
- non-functional requirements not obvious in code
- alternatives a reasonable future reader or agent may propose again
- consequences the team accepts, including negative and neutral ones

If a missing fact blocks a truthful ADR, ask one structured question with options and a recommended default. Do not fill with `TBD`.

Done when context, decision, alternatives, and consequences are specific enough to write without placeholders.

### 4. Write the ADR

Use this template by default:

```md
# ADR-NNN: Short title phrased as the decision

Status: Proposed | Accepted | Rejected | Deprecated | Superseded by ADR-NNN
Date: YYYY-MM-DD
Authors: Names or handles

## Context

What forced this decision. Include the constraints and forces in tension. Keep this neutral; do not sell the decision.

## Decision

We will use X for Y.

## Consequences

- Easier: ...
- Harder: ...
- Accepted risk: ...

## Alternatives considered

- X — rejected because ...
- Y — rejected because ...

## Related

- ADR-NNN
- Incident/RFC/vendor/SLA link
```

Omit `Related` when empty. Omit `Authors` only if the repo's ADR style omits it. Keep the whole ADR short: usually one or two pages, often less.

Done when the ADR records one decision in active voice with concrete trade-offs.

### 5. Self-review

Reject the draft if any check fails:

- One ADR records one significant decision.
- `Context` explains why now and why not the obvious alternative.
- `Decision` is one or two active-voice sentences.
- `Consequences` include bad or neutral effects, not only benefits.
- `Alternatives considered` prevents re-litigation of plausible rejected options.
- The ADR is in the repo, near code, so agents can retrieve it.
- No ratification theater: the ADR ships with the change that introduces or changes the architecture.

Done when a future reader can avoid blind acceptance and blind reversal.
