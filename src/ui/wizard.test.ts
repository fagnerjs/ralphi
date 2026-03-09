import test from 'node:test';
import assert from 'node:assert/strict';

import { isSoftLineBreakInput, screenBlocksCharacterShortcuts } from './wizard.js';

test('screenBlocksCharacterShortcuts blocks global character shortcuts in text entry screens only', () => {
  assert.equal(screenBlocksCharacterShortcuts('brief'), true);
  assert.equal(screenBlocksCharacterShortcuts('idea-chat'), true);
  assert.equal(screenBlocksCharacterShortcuts('prd-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('backlog-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('skill-input'), true);
  assert.equal(screenBlocksCharacterShortcuts('notification-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('cleanup-confirm'), true);
  assert.equal(screenBlocksCharacterShortcuts('provider'), false);
  assert.equal(screenBlocksCharacterShortcuts('backlog'), false);
  assert.equal(screenBlocksCharacterShortcuts('home'), false);
});

test('isSoftLineBreakInput recognizes multiline enter variants', () => {
  assert.equal(isSoftLineBreakInput('\n', {}), true);
  assert.equal(isSoftLineBreakInput('', { return: true, shift: true }), true);
  assert.equal(isSoftLineBreakInput('\u001b[13;2u', {}), true);
  assert.equal(isSoftLineBreakInput('\u001b[27;2;13~', {}), true);
  assert.equal(isSoftLineBreakInput('\r', { return: true }), false);
});
