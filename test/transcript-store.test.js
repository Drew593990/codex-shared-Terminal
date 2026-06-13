const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TranscriptStore } = require('../server/transcript-store');

test('TranscriptStore appends records and reads them in order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-transcript-'));
  try {
    const store = new TranscriptStore(root);

    await store.append('main', 'input', 'Write-Output "hello"\r');
    await store.append('main', 'output', 'hello\r\n');

    const records = await store.read('main');
    assert.equal(records.length, 2);
    assert.equal(records[0].session, 'main');
    assert.equal(records[0].direction, 'input');
    assert.equal(records[0].data, 'Write-Output "hello"\r');
    assert.equal(records[1].direction, 'output');
    assert.equal(records[1].data, 'hello\r\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('TranscriptStore read returns the newest limit records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shareterminal-transcript-'));
  try {
    const store = new TranscriptStore(root);

    await store.append('main', 'output', 'one');
    await store.append('main', 'output', 'two');
    await store.append('main', 'output', 'three');

    const records = await store.read('main', 2);
    assert.deepEqual(records.map((record) => record.data), ['two', 'three']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

