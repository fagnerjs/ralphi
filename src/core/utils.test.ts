import test from 'node:test';
import assert from 'node:assert/strict';

import { extractBacklogMarker } from './utils.js';

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
