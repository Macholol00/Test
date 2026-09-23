'use strict';
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.CLAUDE_BIN = path.join(__dirname, 'fake-claude.js');
process.env.BRIDGE_WORKDIR = path.join(require('os').tmpdir(), 'st-cloud-bridge-test');
const { server, buildPrompt, cleanReply } = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (body) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('lists a model', async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).data[0].id, 'claude-cloud');
});

test('non-streaming completion with stop sequence', async () => {
  const r = await post({
    messages: [
      { role: 'system', content: 'You are Aria.' },
      { role: 'user', content: 'Hello there' },
    ],
    stop: ['\nUSER:'],
  });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.choices[0].message.content, 'Echo: Hello there');
});

test('streaming completion', async () => {
  const r = await post({ stream: true, messages: [{ role: 'user', content: 'Stream me' }], stop: '\nUSER:' });
  const text = await r.text();
  const chunks = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.strictEqual(chunks.at(-1), '[DONE]');
  assert.strictEqual(JSON.parse(chunks[0]).choices[0].delta.content, 'Echo: Stream me');
});

test('assistant prefill is passed through', async () => {
  const r = await post({
    messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Aria smiles' }],
    stop: ['\nUSER:'],
  });
  assert.match((await r.json()).choices[0].message.content, /\[prefilled\]/);
});

test('CLI failure becomes a 502 with the error', async () => {
  const r = await post({ messages: [{ role: 'user', content: 'FAIL_PLEASE' }] });
  assert.strictEqual(r.status, 502);
  assert.match((await r.json()).error.message, /failed to start/);
});

test('buildPrompt keeps system prompt separate from turns', () => {
  const { prompt } = buildPrompt(
    [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U1', name: 'Bob' }],
    {},
  );
  assert.match(prompt, /<INSTRUCTIONS>\nSYS\n<\/INSTRUCTIONS>/);
  assert.match(prompt, /<USER \(Bob\)>\nU1\n<\/USER>/);
});

test('cleanReply strips fences and tags', () => {
  assert.strictEqual(cleanReply('```\n<ASSISTANT>hi</ASSISTANT>\n```'), 'hi');
});
