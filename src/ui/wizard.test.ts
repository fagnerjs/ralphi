import test from 'node:test';
import assert from 'node:assert/strict';

import { screenBlocksCharacterShortcuts } from './wizard.js';

test('screenBlocksCharacterShortcuts blocks global character shortcuts in text entry screens only', () => {
  assert.equal(screenBlocksCharacterShortcuts('brief'), true);
  assert.equal(screenBlocksCharacterShortcuts('prd-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('backlog-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('skill-input'), true);
  assert.equal(screenBlocksCharacterShortcuts('notification-edit'), true);
  assert.equal(screenBlocksCharacterShortcuts('cleanup-confirm'), true);
  assert.equal(screenBlocksCharacterShortcuts('provider'), false);
  assert.equal(screenBlocksCharacterShortcuts('backlog'), false);
  assert.equal(screenBlocksCharacterShortcuts('home'), false);
});
