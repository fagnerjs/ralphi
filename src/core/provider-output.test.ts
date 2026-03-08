import test from 'node:test';
import assert from 'node:assert/strict';

import { observeProviderOutputLine } from './provider-output.js';

test('observeProviderOutputLine extracts anthropic-style assistant text and session ids', () => {
  const line = JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    message: {
      id: 'msg-1',
      content: [
        {
          type: 'text',
          text: '<ralphi-backlog item="BT-001" step="ST-001-01" status="in_progress">'
        },
        {
          type: 'text',
          text: 'Running implementation checks'
        }
      ]
    }
  });

  const observed = observeProviderOutputLine('claude', line);

  assert.equal(observed.isStructured, true);
  assert.equal(observed.sessionId, 'session-1');
  assert.deepEqual(observed.displayLines, [
    '<ralphi-backlog item="BT-001" step="ST-001-01" status="in_progress">',
    'Running implementation checks'
  ]);
});

test('observeProviderOutputLine captures codex thread ids from json events', () => {
  const observed = observeProviderOutputLine(
    'codex',
    JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-123'
    })
  );

  assert.equal(observed.isStructured, true);
  assert.equal(observed.threadId, 'thread-123');
});

test('observeProviderOutputLine summarizes opencode tool events', () => {
  const observed = observeProviderOutputLine(
    'opencode',
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'session-2',
      part: {
        type: 'tool_use',
        tool: 'bash'
      }
    })
  );

  assert.equal(observed.sessionId, 'session-2');
  assert.deepEqual(observed.displayLines, ['Tool: bash']);
});
