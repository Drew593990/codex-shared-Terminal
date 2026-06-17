# Phase 2 Direction Update: Main Terminal With Agent Cards

Date: 2026-06-17

This document supersedes the earlier phase 2 UI direction that treated the
workspace as a grid of equal terminal panes. That grid is not the desired
interaction model.

For future development, the normative contract is
[`development-contract.md`](development-contract.md). This file explains the
product direction and current implementation status; the contract file is the
gate used for tests, UI review, and follow-up implementation work.

## Correct Product Direction

ShareTerminal phase 2 should use one primary command surface:

- the main terminal remains a real visible xterm terminal, backed by the current
  `main` PowerShell session;
- the user and Codex use this main terminal as the command and supervision
  surface;
- the main terminal can address local agents with commands such as
  `@opencode`, `@claude`, `@team`, `@leader`, and concrete ids such as
  `@opencode1`;
- addressed agents appear below the main terminal as agent child interfaces;
- child interfaces can be added, removed, stopped, collapsed, or expanded;
- each child interface lets the user choose which local agent CLI it runs, such
  as `opencode`, Claude Code, or future profiles;
- the child interface is not required to look like PowerShell.

The target layout is:

```text
ShareTerminal header

Main terminal
  real xterm / PowerShell / command surface
  user can type @opencode, @claude, @team, normal shell commands

Agent workspace
  controls: Add agent, remove agent, profile selector, leader selector
  agent card: opencode1
    structured prompt/reply/task state/result
    expandable raw CLI output
  agent card: claude1
    structured prompt/reply/task state/result
    expandable raw CLI output
  Review [collapsed]: roster / task board / inbox / trace / messages
```

## Required Interaction Model

### Main Terminal

The main terminal is the only always-visible terminal surface.

It must keep the existing terminal behavior:

- visible xterm rendering;
- user keyboard input;
- Codex/API input injection;
- persistent transcript;
- reconnect after server restart;
- normal PowerShell commands.

It also becomes the team command surface. Commands containing agent mentions are
parsed by ShareTerminal before or alongside normal shell input.

Examples:

```text
@opencode inspect the current project and summarize the server entry points
@claude review the UI direction and list risks
@team split the task: @opencode inspect backend, @claude inspect UX
```

The exact parsing mechanism can be incremental. The important product rule is
that the user should not need to leave the main terminal to initiate agent team
work.

### Agent Child Interfaces

Agent child interfaces live under the main terminal.

They are structured work cards, not full PowerShell clone panes. Each card
should include:

- agent id, for example `opencode1`;
- selected profile/CLI, for example `opencode` or `claude`;
- role, for example `leader`, `worker`, `reviewer`, or `observer`;
- status, for example `idle`, `running`, `waiting`, `completed`, or `failed`;
- current prompt or assigned task;
- structured agent reply/result;
- latest handoff or message;
- a manual user message box addressed to that exact card;
- action controls: run, stop, remove, retry, collapse, expand raw output;
- optional raw CLI output region.

The default view should prioritize structured dialogue:

```text
opencode1 | worker | running
Prompt
  Inspect server/web-server.js and report the team APIs.

Reply
  Found roster, task, dispatch, inbox, trace, and workspace endpoints...

Raw CLI output [collapsed]
```

Raw CLI output is still important, but it should be expandable evidence, not the
primary visual structure.

The default workspace must not make every backend state surface compete for
attention. Roster, task list, inbox, trace, and message history belong in a
collapsed `Review` area. The primary surface is the team composer plus the
agent cards.

### Manual User Intervention

The user must be able to intervene without leaving the shared workspace:

- a `Team Message` composer posts a durable message to the current leader with
  an `@team` mention;
- a `Team Task` composer creates dispatchable work for the team;
- every active agent card has its own message textarea and send action;
- manual messages are stored through the team message API so they survive
  refresh and can appear in agent inbox/context state;
- sending a message is not the same as dispatching a task unless the user uses
  the task composer or the main terminal `@agent` command path.

### Add / Remove / Select Agent CLI

The agent workspace must expose explicit controls:

- add a child agent card;
- choose the profile for that card from the available local CLI profiles;
- optionally type or auto-generate the agent id;
- remove an idle or completed child card;
- stop/cancel a running card before removal;
- switch role or leader when allowed.

Adding `opencode` twice should create two separate child cards, for example
`opencode1` and `opencode2`. It should not replace an existing card.

### Automatic Card Creation From Mentions

The system should create or reuse cards based on mentions from the main
terminal:

- `@opencode` should reuse an idle `opencode` card if one exists, or create a
  new `opencodeN` card if no suitable card exists;
- `@claude` should do the same for Claude Code;
- `@opencode1` should target that exact card;
- `@team` should route the request to the current leader and keep worker cards
  visible as work is delegated;
- if a profile is unknown or disabled, the main terminal should receive a clear
  visible error notice.

This behavior is different from the current implementation, where roster agents
can appear as equal terminal panes without the main terminal acting as the
command hub.

### Agent Collaboration

Agent collaboration should be visible through cards and backed by durable state:

- the leader card receives the original user request and shared context;
- worker cards receive child tasks;
- worker results return to the leader card;
- inter-agent messages are shown as card events or handoffs;
- final delivery is tied to the leader card and links to worker evidence;
- inbox and trace reconstruct the work from task id, message id, or result id.

The backend team APIs remain important, but they should support the visible
main-terminal-and-card workflow rather than becoming a separate hidden workflow.

## What Must Change From The Current Prototype

The current phase 2 prototype is only a partial backend and UI foundation. It
does not satisfy the desired interaction model because:

- it renders multiple sessions as equal terminal panes;
- historical/smoke roster agents can fill the workspace with stale PowerShell
  panes;
- the main terminal is not the obvious command hub for `@agent` orchestration;
- agent outputs are not represented as structured prompt/reply/result cards;
- add/remove/select controls are not centered around child cards;
- raw CLI output is always terminal-shaped instead of optional evidence.

Future work should not continue expanding the equal-pane grid. It should
replace it with the main-terminal-plus-agent-card model.

## Implementation Direction For The Next Normalized Pass

The implementation should proceed in small slices:

1. Update the UI contract tests so the page requires:
   - one main terminal region;
   - one agent workspace region below it;
   - agent cards with profile selectors and remove controls;
   - structured prompt/reply/result sections;
   - expandable raw output sections.
2. Refactor the browser layout:
   - keep `main` as the only default xterm pane;
   - move team controls under the main terminal;
   - render roster agents as `agent-card` components;
   - remove stale/smoke cards from the default visible state unless explicitly
     restored from active task state.
3. Add mention handling from main terminal input:
   - detect `@profile`, `@agentId`, `@team`, and `@leader`;
   - create or reuse agent cards;
   - create team tasks or direct turns;
   - publish a visible notice back to the main terminal.
4. Connect agent cards to existing backend state:
   - roster entries;
   - tasks;
   - messages;
   - inbox items;
   - trace records;
   - direct conversation turns.
5. Preserve raw CLI evidence:
   - keep PTY/session support available per agent when needed;
   - show raw output only inside an expandable card section;
   - default the card to structured dialogue and task state.
6. Add local smoke tests:
   - start ShareTerminal;
   - type or submit an `@opencode` or `@echo` command through the main
     terminal/API path;
   - verify a child card is created;
   - verify structured result appears in the card;
   - verify raw output can be expanded when available.

## Acceptance Criteria

The revised phase 2 direction is not complete until these are true:

- the first screen clearly shows one main terminal, not a grid of peer
  terminals;
- the user can add and remove agent child cards from the UI;
- each card can select which local agent CLI/profile it runs;
- typing a mention in the main terminal can create or reuse the relevant child
  card;
- `@team` work is visible as leader and worker card activity;
- structured prompt/reply/result state is visible without reading raw terminal
  scrollback;
- raw CLI output can be expanded for evidence or debugging;
- stale smoke/test agents do not clutter the default workspace;
- backend task, message, inbox, and trace state remain durable and inspectable.

## Current Implementation Status

Implemented on the `phase2` branch:

- the browser layout now uses one `main` xterm region followed by an
  `Agent Workspace` section;
- active roster agents render as structured `agent-card` child interfaces
  instead of peer PowerShell terminal panes;
- each card shows agent id, profile, role, status, prompt, structured reply,
  task result, remove action, task lifecycle actions, and a collapsed raw CLI
  output section;
- each card now exposes task-level Run, Stop, Retry, Resume, and Trace actions
  backed by the existing durable task APIs;
- Stop now propagates through the running team task to the direct agent
  adapter. Command and PTY-based local CLI turns receive an abort signal and
  their subprocess is killed before the task settles as `cancelled`;
- the Agent Workspace header exposes profile selection, optional agent id,
  API token, add, and refresh controls;
- a first-class `Team Flow` view summarizes leader and worker task nodes from
  the latest team task or selected trace, so `@team` work is visible as a
  workflow instead of only as separate task/inbox/trace lists;
- removed cards are hidden by default but can be shown as collapsed audit
  records through a persisted `Removed` toggle in the Agent Workspace header;
- `POST /api/team/commands/mention` accepts main-terminal commands such as
  `@echo inspect docs`, creates or reuses an agent, creates a task, dispatches
  it, and returns the updated agent/task;
- the browser intercepts main-terminal lines that begin with `@` and routes
  them to the mention command API instead of sending them to PowerShell;
- normal non-mention terminal input still goes to the underlying PTY;
- `scripts/smoke-main-terminal-agent-cards.ps1` verifies the mention command
  chain, roster state, task completion, trace, and inbox;
- browser verification confirmed that a typed main-terminal `@echo ...`
  command updates the `echo1` card and does not create peer terminal panes.
- browser verification on an isolated smoke server confirmed that a split
  `@team` task renders one leader node, two worker nodes, three agent cards,
  card task controls, and no peer terminal panes.
- real local `opencode` and Claude Code direct card workflows were validated
  through the main-terminal mention API. `@opencode` returned
  `OPENCODE_CARD_SMOKE_OK`, and `@claude` returned `CLAUDE_CARD_SMOKE_OK`.

This implementation is a foundation, not the final normalized product contract.
The next pass must be judged against
[`development-contract.md`](development-contract.md), especially:

- no default peer terminal panes under the main terminal;
- agent work appears as structured cards with raw output collapsed by default;
- `@profile`, `@agentId`, `@leader`, and `@team` route to the correct concrete
  card and task owner;
- user and Codex interaction stays in the same visible main terminal context;
- browser verification confirms what the user can actually see and type into.
