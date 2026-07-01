---
name: loop-engineering
description: create good autonomous agent loops.
disable-model-invocation: true
---

# Loop Engineering

A good loop is a contract: **trigger → act → verify → record → repeat/stop**. Build the smallest loop whose verifier can tell done from not-done.

## Steps

### 1. Prove a loop should exist

Use a loop only when the work repeats, the scope is tight, and a machine can cheaply verify the result.

Reject loops for one-shot edits, open-ended research, or work whose only real verifier is human taste.

Done when the task is either rejected with one reason, or narrowed to one repeatable job with an automated check.

### 2. Write the loop contract

Specify:

- **Trigger:** cron, webhook, issue label, queue item, file change, incident, or another agent.
- **Goal:** one checkable end state.
- **Scope:** allowed repos, files, data, and actions.
- **Budget:** max attempts, runtime, files changed, spend, and consecutive failures.
- **Stop:** pass condition, budget exhaustion, ambiguity, or human gate.
- **Evidence:** command output, CI, eval score, deployed probe, empty queue, artifact diff.

Done when every field is concrete enough that another agent could run the loop without redefining success.

### 3. Build the harness before autonomy

A loop needs the same six pieces every time:

1. isolated workspace per run, usually a git worktree or sandbox
2. written project context loaded every run
3. tools/connectors for the systems it must change
4. independent verifier, not the same worker grading itself
5. durable state on disk: queue, log, board, or markdown memory
6. human gates for irreversible, sensitive, or taste-heavy actions

Done when each piece has an exact path, command, service, or owner; missing pieces are explicit blockers, not assumptions.

### 4. Run one tight pilot

Start with one real item and a small cadence. The first loop should do less than the final loop: one PR, one queue, one label, one verifier.

Record the transcript, artifacts, verifier result, cost, duration, and why it stopped.

Done when one pilot run leaves durable evidence and the stop reason is correct.

### 5. Hill-climb from traces

Improve the loop from repeated run evidence, not vibes. Tune in this order:

1. verifier/rubric
2. scope and budget
3. context and tools
4. prompt
5. model

Track cost per finished task, not cost per call. A cheap model that loops twice as often is not cheaper.

Done when each change cites a trace pattern or failed verifier, and no change weakens the stop condition.

## Loop stack

- **Agent loop:** model calls tools until the task ends.
- **Verification loop:** grader checks output and feeds back failures.
- **Event loop:** triggers run the agent without a human pressing go.
- **Hill-climbing loop:** traces improve the harness itself.

Prefer adding the lowest loop that fixes the problem. Do not add eventing before verification works.

## Failure modes

- Vague goal: loop redefines done.
- Weak verifier: bad work compounds.
- Self-grading: producer approves its own mistakes.
- No budget: stuck loop burns money.
- No isolation: parallel agents overwrite each other.
- No durable state: every run rediscovers the world.
- Broad scope: loop wanders into unrelated work.
- Human review bottleneck: automation only moves the queue.
- Shared bad signal: one loop poisons the memory other loops read.

## Source anchors

- LangChain, “The Art of Loop Engineering”: agent, verification, event, and hill-climbing loop stack.
- Omar Sar / Mohamed Elkholy, “From Prompting Agents to Loop Engineering”: contract fields, verifier, budgets, state, and failure modes.
- Jason Zhou, “wtf is Loop Engineer & how to setup for real”: shared file memory, triggers, harness, connectors, and compounding loops.
