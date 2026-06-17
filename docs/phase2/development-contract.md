# Phase 2 Development Contract: Main Terminal And Agent Cards

Date: 2026-06-17

This document is the normative development direction for the next Phase 2
iteration. If another document, test, or prototype implies an equal multi-pane
terminal grid, this document takes precedence.

## Product Goal

Phase 2 must turn ShareTerminal into one shared command workspace where the
human user, Codex App, and local CLI agents can cooperate without losing a
single visible interaction context.

The core problem being solved is specific:

1. When Codex App or another agent runs a CLI in a private command execution,
   the user cannot see, type into, interrupt, or help recover that run.
2. When Codex repeatedly launches CLIs such as `opencode` or Claude Code as
   one-shot commands, long conversations are fragmented and must be restarted
   instead of continued.

The target is not a generic multi-terminal dashboard. The target is one main
terminal plus visible, controllable agent work cards underneath it.

## Non-Negotiable UI Contract

The browser UI must have exactly one primary terminal surface by default:

- `main` remains the real xterm-backed terminal for PowerShell and normal shell
  work;
- the user can keep typing in `main` while agent work is running;
- Codex and other local agents can inject input into that same `main` surface
  through the API;
- `@opencode`, `@claude`, `@team`, `@leader`, and concrete mentions such as
  `@opencode1` are initiated from this main terminal path;
- additional agents must not appear as peer PowerShell terminal panes by
  default.

Child agents live below the main terminal as cards. A child card is the visible
unit of agent work, not a cloned terminal.

Each card must expose:

- agent id, for example `opencode1`;
- selected CLI profile, for example `opencode`, `claude`, or a future local
  profile;
- role, for example `leader`, `worker`, `reviewer`, or `observer`;
- lifecycle status, for example `idle`, `queued`, `running`, `waiting`,
  `completed`, `failed`, `cancelled`, or `removed`;
- prompt or assigned task;
- structured reply, result, error, and latest handoff;
- controls to run, stop, retry, resume, trace, remove, collapse, and expand;
- raw CLI output only as an expandable evidence section.

The default card view is structured conversation:

```text
opencode1 | opencode | worker | running

Prompt
  Inspect server/web-server.js and list the team APIs.

Reply
  Found roster, task, dispatch, inbox, trace, workspace, and message routes.

Actions
  Stop | Trace | Raw output
```

Raw CLI output remains available for debugging and audit, but it must not be the
default reading experience.

## Agent Workspace Contract

The region below the main terminal is the Agent Workspace. It must provide:

- add child agent card;
- choose the profile for the new card;
- optionally provide a stable agent id;
- remove idle, completed, failed, or cancelled cards;
- stop or cancel running cards before removal;
- mark or switch the leader when allowed;
- hide removed cards by default while keeping them available as audit records;
- show the current team flow for leader, worker, handoff, and final-result
  activity.

Adding the same profile more than once creates separate instances, such as
`opencode1` and `opencode2`. A new instance must not replace an existing one.

## Mention Routing Contract

Mentions entered through the main terminal are the primary user-facing command
mechanism:

- `@opencode <prompt>` reuses an idle `opencode` card when one exists, or
  creates a new `opencodeN` card when needed;
- `@claude <prompt>` follows the same rule for Claude Code;
- `@opencode1 <prompt>` targets that exact card;
- `@leader <prompt>` targets the current leader card;
- `@team <prompt>` creates a visible team task, routes planning to the leader,
  and keeps worker activity visible in cards and team flow;
- unknown or disabled profiles produce a visible error notice in the main
  terminal and a structured API error.

The original mention text must be preserved in task and trace state. Resolved
routes must also store the concrete target agent id so UI cards do not infer
ownership from ambiguous leader metadata.

## Collaboration And State Contract

The backend team layer exists to support the visible workspace, not to create a
separate hidden workflow.

Every user-visible agent action must be backed by durable state:

- roster agent;
- task;
- message or handoff when agents communicate;
- inbox item when a result needs user or leader acknowledgement;
- trace records that reconstruct the work from task id, message id, inbox id,
  or result id;
- terminal notice for important lifecycle changes.

`@team` work must make the collaboration path readable:

1. the leader card receives the original user request and shared context;
2. worker cards receive child tasks;
3. worker replies return to the leader;
4. the leader reviews or requests fixes;
5. the final answer is tied to the leader card and links to worker evidence.

## Implementation Rules

Development must proceed with tests that encode the product contract before UI
or backend behavior changes.

Required test coverage for each slice:

- UI contract test: one main terminal, no default peer terminal grid, cards
  below the main terminal, structured sections present, raw output collapsed by
  default;
- routing test: `@profile`, `@agentId`, `@leader`, and `@team` resolve to the
  expected concrete card/task ownership;
- lifecycle test: run, stop/cancel, retry, resume, remove, and trace leave
  durable state;
- browser verification: the actual page at `127.0.0.1:7842` shows the intended
  visible state;
- real local CLI smoke when adapter behavior changes: at minimum `opencode` and
  Claude Code if they are installed;
- security scan before publishing: no personal paths, local tokens, or API keys
  in committed docs or code.

Avoid broad rewrites. Keep changes in small slices:

1. contract tests;
2. UI layout and cards;
3. mention routing and ownership;
4. task lifecycle controls;
5. team flow and inter-agent handoffs;
6. real CLI adapter validation;
7. docs and startup guidance.

## Explicit Anti-Goals

Do not build these into the next iteration:

- an equal grid of multiple default terminal panes;
- a hidden background agent workflow that the user cannot inspect or interrupt;
- autonomous loops that continue without visible state or user control;
- a CCB/tmux clone;
- copied AGPL code from reference projects;
- cloud orchestration or public network exposure.

## Done Criteria

The next iteration is not done until all of these are true:

- first load shows one main terminal and an Agent Workspace, not peer terminal
  panes;
- adding and removing cards works from the UI;
- each card can select or display its CLI profile;
- `@opencode` and `@claude` create or reuse cards and show structured replies;
- `@team` shows leader and worker activity in cards and team flow;
- raw output is available but collapsed by default;
- removed cards are hidden by default and recoverable as audit records;
- task ownership is shown on the correct card even when the same leader owns a
  team run;
- full unit tests, route tests, smoke tests, and browser verification pass.
