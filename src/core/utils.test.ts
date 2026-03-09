import test from 'node:test';
import assert from 'node:assert/strict';

import { extractBacklogMarker, extractDigitInput, extractPrintableInput, isPrintableInput } from './utils.js';

test('extractPrintableInput keeps pasted chunks and normalizes multiline text', () => {
  assert.equal(extractPrintableInput('hello world'), 'hello world');
  assert.equal(extractPrintableInput('hello\r\nworld'), 'helloworld');
  assert.equal(extractPrintableInput('hello\r\nworld', { allowNewlines: true }), 'hello\nworld');
  assert.equal(extractPrintableInput('\u001b[200~hello\u001b[201~'), 'hello');
});

test('extractDigitInput keeps every digit from pasted numeric text', () => {
  assert.equal(extractDigitInput('1,024\n'), '1024');
  assert.equal(extractDigitInput('limit: 5000 tokens'), '5000');
});

test('isPrintableInput accepts pasted text chunks', () => {
  assert.equal(isPrintableInput('paste me'), true);
  assert.equal(isPrintableInput('\n'), false);
});

test('extractBacklogMarker parses markers embedded inside escaped json strings', () => {
  const marker = extractBacklogMarker(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"<ralphi-backlog item=\\"BT-001\\" step=\\"ST-001-01\\" status=\\"done\\">"}]}}'
  );

  assert.deepEqual(marker, {
    itemId: 'BT-001',
    stepId: 'ST-001-01',
    status: 'done'
  });
});
