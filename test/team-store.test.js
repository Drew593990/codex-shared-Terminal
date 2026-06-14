const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TeamStore } = require('../server/team-store');

function createClock() {
  const values = [
    '2026-06-14T02:00:00.000Z',
    '2026-06-14T02:00:01.000Z',
    '2026-06-14T02:00:02.000Z',
    '2026-06-14T02:00:03.000Z',
    '2026-06-14T02:00:04.000Z',
    '2026-06-14T02:00:05.000Z'
  ];
  return () => values.shift() || '2026-06-14T02:00:59.000Z';
}

function createIncrementingClock(start = '2026-06-14T02:20:00.000Z') {
  let offset = 0;
  const startMs = new Date(start).getTime();
  return () => new Date(startMs + offset++ * 1000).toISOString();
}

test('TeamStore keeps repeatable agent instances and marks the first one as leader', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, { now: createClock() });

    const first = await store.addRosterAgent({ profileId: 'opencode' });
    const second = await store.addRosterAgent({ profileId: 'opencode' });
    const reviewer = await store.addRosterAgent({
      profileId: 'claude',
      agentId: 'claude-code1',
      role: 'reviewer'
    });

    assert.equal(first.agentId, 'opencode1');
    assert.equal(first.role, 'leader');
    assert.equal(first.status, 'idle');
    assert.equal(second.agentId, 'opencode2');
    assert.equal(second.role, 'worker');
    assert.equal(reviewer.agentId, 'claude-code1');
    assert.equal(reviewer.role, 'reviewer');

    const roster = await store.listRoster();
    assert.deepEqual(roster.map((agent) => agent.agentId), ['opencode1', 'opencode2', 'claude-code1']);
    assert.equal(roster.find((agent) => agent.agentId === 'opencode1').role, 'leader');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore rejects unknown or disabled roster agent profiles when registry is configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      profiles: {
        opencode: { label: 'opencode', enabled: true },
        disabled: { label: 'Disabled', enabled: false }
      }
    });

    await assert.rejects(
      () => store.addRosterAgent({ profileId: 'missing' }),
      /Unknown agent profile: missing/
    );
    await assert.rejects(
      () => store.addRosterAgent({ profileId: 'disabled' }),
      /Agent profile is disabled: disabled/
    );

    const agent = await store.addRosterAgent({ profileId: 'opencode' });

    assert.equal(agent.agentId, 'opencode1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore reads BOM-prefixed JSONL records for manual recovery files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    await writeFile(
      path.join(root, 'roster.jsonl'),
      `\uFEFF${JSON.stringify({ agentId: 'echo1', profileId: 'echo', role: 'leader', status: 'idle' })}\n`,
      'utf8'
    );
    const store = new TeamStore(root, { profiles: { echo: { label: 'Echo', mode: 'echo' } } });

    const roster = await store.listRoster();

    assert.equal(roster[0].agentId, 'echo1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore routes @team tasks to the leader and records mentions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => 'task-1',
      messageIdFactory: () => 'message-1'
    });
    await store.addRosterAgent({ profileId: 'opencode' });
    await store.addRosterAgent({ profileId: 'opencode' });

    const task = await store.createTask({
      title: 'Review parser changes',
      prompt: '@team split the work, ask @opencode2 to inspect tests, then produce one final delivery.',
      createdBy: 'codex',
      assignedTo: '@team'
    });

    assert.equal(task.taskId, 'task-1');
    assert.equal(task.assignedTo, '@team');
    assert.equal(task.leaderAgentId, 'opencode1');
    assert.deepEqual(task.mentions, ['@team', '@opencode2']);
    assert.equal(task.status, 'queued');

    const messages = await store.listMessages({ agent: 'opencode1' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, 'message-1');
    assert.equal(messages[0].from, 'codex');
    assert.equal(messages[0].to, 'opencode1');
    assert.deepEqual(messages[0].mentions, ['@team', '@opencode2']);
    assert.equal(messages[0].status, 'pending');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore resolves profile mentions to an idle concrete agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      profiles: {
        opencode: { label: 'opencode', enabled: true },
        claude: { label: 'Claude', enabled: true }
      },
      taskIdFactory: () => 'task-profile-mention',
      messageIdFactory: (() => {
        let index = 0;
        return () => `message-profile-${++index}`;
      })()
    });
    await store.addRosterAgent({ profileId: 'opencode' });
    await store.addRosterAgent({ profileId: 'opencode' });
    await store.addRosterAgent({ profileId: 'claude', agentId: 'claude1', role: 'reviewer' });

    const task = await store.createTask({
      title: 'Profile mention route',
      prompt: '@team ask @opencode to inspect tests and @claude to review.',
      createdBy: 'codex',
      assignedTo: '@team'
    });
    const inbox = await store.agentInbox('opencode2');
    const claimed = await store.claimTask(task.taskId, { agentId: 'opencode2' });

    assert.deepEqual(task.mentions, ['@team', '@opencode', '@claude']);
    assert.deepEqual(task.mentionRoutes.map((route) => [route.mention, route.agentId, route.profileId]), [
      ['@opencode', 'opencode2', 'opencode'],
      ['@claude', 'claude1', 'claude']
    ]);
    assert.deepEqual(inbox.tasks.map((item) => item.taskId), [task.taskId]);
    assert.equal(claimed.claimedBy, 'opencode2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore supports direct mention messages and leader reassignment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      messageIdFactory: (() => {
        let index = 0;
        return () => `message-${++index}`;
      })()
    });
    await store.addRosterAgent({ profileId: 'opencode' });
    await store.addRosterAgent({ profileId: 'opencode' });
    await store.setLeader('opencode2');

    const message = await store.sendMessage({
      from: 'codex',
      to: '@leader',
      body: '@leader check opencode1 output before final delivery.'
    });

    assert.equal(message.to, 'opencode2');
    assert.deepEqual(message.mentions, ['@leader']);

    const roster = await store.listRoster();
    assert.equal(roster.find((agent) => agent.agentId === 'opencode1').role, 'worker');
    assert.equal(roster.find((agent) => agent.agentId === 'opencode2').role, 'leader');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore records task lifecycle events for dispatch tracing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => 'task-1',
      messageIdFactory: () => 'message-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const queued = await store.createTask({
      title: 'Dispatch smoke',
      prompt: '@leader run this task',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const running = await store.startTask(queued.taskId, {
      agentId: 'echo1',
      mode: 'direct',
      turnId: 'turn-1'
    });
    const completed = await store.completeTask(queued.taskId, {
      agentId: 'echo1',
      result: 'reply from echo',
      turnId: 'turn-1'
    });
    const trace = await store.trace(queued.taskId);

    assert.equal(running.status, 'running');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result, 'reply from echo');
    assert.equal((await store.listRoster()).find((agent) => agent.agentId === 'echo1').status, 'idle');
    assert.deepEqual(trace.events.map((event) => event.type), [
      'task.created',
      'message.sent',
      'task.running',
      'task.completed'
    ]);
    assert.equal(trace.task.taskId, 'task-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore writes completed task results into an ackable inbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => 'task-1',
      messageIdFactory: () => 'message-1',
      inboxIdFactory: () => 'inbox-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const queued = await store.createTask({
      title: 'Inbox delivery',
      prompt: '@leader produce result',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    await store.startTask(queued.taskId, { agentId: 'echo1', mode: 'direct' });
    await store.completeTask(queued.taskId, {
      agentId: 'echo1',
      result: 'checked final result',
      turnId: 'turn-1'
    });

    const inbox = await store.listInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].inboxId, 'inbox-1');
    assert.equal(inbox[0].taskId, queued.taskId);
    assert.equal(inbox[0].status, 'unread');
    assert.equal(inbox[0].summary, 'checked final result');

    const acked = await store.ackInboxItem('inbox-1', { ackedBy: 'user' });
    assert.equal(acked.status, 'acked');
    assert.equal(acked.ackedBy, 'user');

    const afterAck = await store.listInbox();
    assert.equal(afterAck[0].status, 'acked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore cancels queued work and creates traceable retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => `task-${++taskIndex}`,
      messageIdFactory: () => `message-${taskIndex}`
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const queued = await store.createTask({
      title: 'Recoverable task',
      prompt: '@leader do recoverable work',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const cancelled = await store.cancelTask(queued.taskId, {
      agentId: 'echo1',
      reason: 'user paused the work'
    });
    const retry = await store.retryTask(queued.taskId, {
      createdBy: 'codex',
      reason: 'resume after pause'
    });
    const trace = await store.trace(queued.taskId);

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error, 'user paused the work');
    assert.equal(retry.taskId, 'task-2');
    assert.equal(retry.retryOf, queued.taskId);
    assert.equal(retry.status, 'queued');
    assert.equal(retry.prompt, queued.prompt);
    assert.equal(retry.assignedTo, queued.assignedTo);
    assert.deepEqual(trace.events.map((event) => event.type).slice(-2), [
      'task.cancelled',
      'task.retry.created'
    ]);
    assert.equal(trace.tasks.find((task) => task.taskId === retry.taskId).retryOf, queued.taskId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore lets agents pause work for user input and resume it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createIncrementingClock('2026-06-14T04:00:00.000Z'),
      taskIdFactory: () => `task-user-${++taskIndex}`,
      messageIdFactory: () => `message-user-${taskIndex}`,
      inboxIdFactory: () => 'inbox-user-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await store.createTask({
      title: 'Needs user',
      prompt: '@leader ask for missing credentials',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    await store.claimTask(task.taskId, { agentId: 'echo1', leaseMs: 60000 });
    const paused = await store.requestUserInput(task.taskId, {
      agentId: 'echo1',
      question: 'Please confirm whether to continue with the destructive step.',
      reason: 'approval required before continuing'
    });
    const inbox = await store.listInbox();
    const resumed = await store.resumeTask(task.taskId, {
      resumedBy: 'user',
      answer: 'Continue, but skip deletion.'
    });
    const context = await store.getContext();
    const trace = await store.trace(task.taskId);

    assert.equal(paused.status, 'needs_user');
    assert.equal(paused.claimedBy, null);
    assert.equal(paused.userRequest.question, 'Please confirm whether to continue with the destructive step.');
    assert.equal(inbox[0].type, 'user_request');
    assert.equal(inbox[0].summary, 'Please confirm whether to continue with the destructive step.');
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.userResponse.answer, 'Continue, but skip deletion.');
    assert.match(context.notes.at(-1).body, /Continue, but skip deletion/);
    assert.deepEqual(trace.events.map((event) => event.type).slice(-3), [
      'task.needs_user',
      'context.note',
      'task.resumed'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore exposes an agent inbox with assigned tasks, messages, and context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => `task-${++taskIndex}`,
      messageIdFactory: (() => {
        let index = 0;
        return () => `message-${++index}`;
      })()
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await store.createTask({
      title: 'Agent owned task',
      prompt: '@echo2 inspect the task and report back',
      createdBy: 'codex',
      assignedTo: 'echo2'
    });
    await store.sendMessage({
      from: 'echo1',
      to: 'echo2',
      taskId: task.taskId,
      body: '@echo2 include the current context'
    });
    await store.requestUserInput(task.taskId, {
      agentId: 'echo2',
      question: 'Please provide the missing input.'
    });

    const inbox = await store.agentInbox('echo2');

    assert.equal(inbox.agent.agentId, 'echo2');
    assert.deepEqual(inbox.tasks.map((item) => item.taskId), [task.taskId]);
    assert.deepEqual(inbox.items.map((item) => item.type), ['user_request']);
    assert.equal(inbox.items[0].summary, 'Please provide the missing input.');
    assert.deepEqual(inbox.messages.map((message) => message.to), ['echo2', 'echo2']);
    assert.equal(inbox.context.leader.agentId, 'echo1');
    assert.equal(inbox.context.activeTasks[0].taskId, task.taskId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore includes workspace and runtime metadata in shared context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const store = new TeamStore(root, {
      context: {
        workspace: {
          projectRoot: 'X:\\workspace\\project',
          cwd: 'X:\\workspace\\project'
        },
        runtime: {
          platform: 'win32',
          shell: 'powershell.exe'
        }
      }
    });

    const context = await store.getContext();

    assert.equal(context.workspace.projectRoot, 'X:\\workspace\\project');
    assert.equal(context.workspace.cwd, 'X:\\workspace\\project');
    assert.equal(context.runtime.platform, 'win32');
    assert.equal(context.runtime.shell, 'powershell.exe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore lets agents claim work, heartbeat it, and recover stale running tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    const clockValues = [
      '2026-06-14T02:00:00.000Z',
      '2026-06-14T02:00:01.000Z',
      '2026-06-14T02:00:02.000Z',
      '2026-06-14T02:00:03.000Z',
      '2026-06-14T02:00:04.000Z',
      '2026-06-14T02:00:05.000Z',
      '2026-06-14T02:00:06.000Z',
      '2026-06-14T02:00:07.000Z',
      '2026-06-14T02:00:08.000Z',
      '2026-06-14T02:10:00.000Z',
      '2026-06-14T02:10:01.000Z',
      '2026-06-14T02:10:02.000Z',
      '2026-06-14T02:10:03.000Z',
      '2026-06-14T02:12:00.000Z',
      '2026-06-14T02:12:01.000Z',
      '2026-06-14T02:12:02.000Z',
      '2026-06-14T02:12:03.000Z'
    ];
    const store = new TeamStore(root, {
      now: () => clockValues.shift() || '2026-06-14T02:10:59.000Z',
      taskIdFactory: () => 'task-claim-1',
      messageIdFactory: () => 'message-claim-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await store.createTask({
      title: 'Claimable task',
      prompt: '@leader claim this',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    const claimed = await store.claimTask(task.taskId, {
      agentId: 'echo1',
      mode: 'external',
      leaseMs: 60_000
    });
    const heartbeat = await store.heartbeatTask(task.taskId, {
      agentId: 'echo1',
      leaseMs: 60_000,
      note: 'still working'
    });
    const recovered = await store.recoverStaleTasks({
      staleBefore: '2026-06-14T02:12:00.000Z',
      reason: 'agent heartbeat expired'
    });
    const latest = await store.getTask(task.taskId);
    const trace = await store.trace(task.taskId);

    assert.equal(claimed.status, 'running');
    assert.equal(claimed.claimedBy, 'echo1');
    assert.equal(heartbeat.leaseExpiresAt, '2026-06-14T02:11:00.000Z');
    assert.equal(recovered.length, 1);
    assert.equal(latest.status, 'queued');
    assert.equal(latest.claimedBy, null);
    assert.equal(latest.error, 'agent heartbeat expired');
    assert.deepEqual(trace.events.map((event) => event.type).slice(-3), [
      'task.claimed',
      'task.heartbeat',
      'task.recovered'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore clears agent leases when claimed tasks close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => `task-close-${++taskIndex}`,
      messageIdFactory: () => `message-close-${taskIndex}`
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    const task = await store.createTask({
      title: 'Claim and close',
      prompt: '@leader close cleanly',
      createdBy: 'codex',
      assignedTo: '@leader'
    });

    await store.claimTask(task.taskId, { agentId: 'echo1', leaseMs: 60000 });
    const completed = await store.completeTask(task.taskId, {
      agentId: 'echo1',
      result: 'done'
    });

    assert.equal(completed.status, 'completed');
    assert.equal(completed.claimedBy, null);
    assert.equal(completed.leaseExpiresAt, null);
    assert.equal((await store.listRoster()).find((agent) => agent.agentId === 'echo1').activeTaskId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore lets the claimant complete work and hand results to the leader', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    let messageIndex = 0;
    const store = new TeamStore(root, {
      now: createIncrementingClock('2026-06-14T02:40:00.000Z'),
      taskIdFactory: () => `task-submit-${++taskIndex}`,
      messageIdFactory: () => `message-submit-${++messageIndex}`,
      inboxIdFactory: () => 'inbox-submit-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await store.createTask({
      title: 'Worker result',
      prompt: '@echo2 inspect and report',
      createdBy: 'echo1',
      assignedTo: 'echo2',
      leaderAgentId: 'echo1'
    });

    await store.claimTask(task.taskId, { agentId: 'echo2', leaseMs: 60000 });
    const completed = await store.completeClaimedTask(task.taskId, {
      agentId: 'echo2',
      result: 'worker checked the files',
      turnId: 'turn-submit-1'
    });
    const inbox = await store.listInbox();
    const leaderMessages = await store.listMessages({ agent: 'echo1' });
    const trace = await store.trace(task.taskId);

    assert.equal(completed.status, 'completed');
    assert.equal(completed.result, 'worker checked the files');
    assert.equal(completed.claimedBy, null);
    assert.equal(completed.reviewedBy, 'echo1');
    assert.equal(inbox[0].taskId, task.taskId);
    assert.equal(inbox[0].agentId, 'echo2');
    assert.match(leaderMessages.at(-1).body, /worker checked the files/);
    assert.equal(leaderMessages.at(-1).from, 'echo2');
    assert.equal(leaderMessages.at(-1).to, 'echo1');
    assert.deepEqual(trace.events.map((event) => event.type).slice(-3), [
      'task.claimed',
      'task.completed',
      'message.sent'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore lets the claimant fail work and records a retryable failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createIncrementingClock('2026-06-14T02:50:00.000Z'),
      taskIdFactory: () => `task-fail-submit-${++taskIndex}`,
      messageIdFactory: () => `message-fail-submit-${taskIndex}`,
      inboxIdFactory: () => 'inbox-fail-submit-1'
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const task = await store.createTask({
      title: 'Worker failure',
      prompt: '@echo2 try risky work',
      createdBy: 'echo1',
      assignedTo: 'echo2',
      leaderAgentId: 'echo1'
    });

    await store.claimTask(task.taskId, { agentId: 'echo2', leaseMs: 60000 });
    await assert.rejects(
      () => store.completeClaimedTask(task.taskId, { agentId: 'echo1', result: 'not mine' }),
      /Task is not claimed by agent: echo1/
    );
    const failed = await store.failClaimedTask(task.taskId, {
      agentId: 'echo2',
      error: 'worker command failed'
    });
    const inbox = await store.listInbox();
    const retry = await store.retryTask(task.taskId, { createdBy: 'echo1' });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'worker command failed');
    assert.equal(failed.claimedBy, null);
    assert.equal(inbox[0].type, 'task_failure');
    assert.equal(inbox[0].summary, 'worker command failed');
    assert.equal(retry.retryOf, task.taskId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TeamStore creates child tasks and includes them in parent trace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-team-'));
  try {
    let taskIndex = 0;
    const store = new TeamStore(root, {
      now: createClock(),
      taskIdFactory: () => `task-${++taskIndex}`,
      messageIdFactory: () => `message-${taskIndex}`
    });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo1' });
    await store.addRosterAgent({ profileId: 'echo', agentId: 'echo2' });
    const parent = await store.createTask({
      title: 'Team parent',
      prompt: '@team ask @echo2 to inspect and then deliver',
      createdBy: 'codex',
      assignedTo: '@team'
    });

    const child = await store.createChildTask(parent.taskId, {
      title: 'Worker inspect',
      prompt: 'Inspect for parent',
      assignedTo: 'echo2',
      createdBy: 'echo1'
    });
    await store.startTask(child.taskId, { agentId: 'echo2', mode: 'direct' });
    await store.completeTask(child.taskId, { agentId: 'echo2', result: 'worker result' });

    const updatedParent = await store.getTask(parent.taskId);
    const trace = await store.trace(parent.taskId);

    assert.equal(child.parentTaskId, parent.taskId);
    assert.deepEqual(updatedParent.childTaskIds, [child.taskId]);
    assert.deepEqual(trace.events.map((event) => event.type), [
      'task.created',
      'message.sent',
      'task.created',
      'message.sent',
      'task.child.created',
      'task.running',
      'task.completed'
    ]);
    assert.equal(trace.tasks.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
