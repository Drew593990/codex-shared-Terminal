const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
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
  return () => values.shift() || '2026-06-14T02:00:99.000Z';
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
