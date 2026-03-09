import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIdeaStatusLines, flattenIdeaTranscript } from './idea-chat.js';

test('flattenIdeaTranscript keeps user and assistant messages visually distinct', () => {
  const lines = flattenIdeaTranscript([
    { role: 'assistant', kind: 'question', content: 'What problem should the first release solve?' },
    { role: 'user', kind: 'message', content: 'Help teams upload videos faster.' }
  ]);

  assert.equal(lines[0]?.text.startsWith('Ralphi · '), true);
  assert.equal(lines[1]?.text.startsWith('You · '), true);
});

test('buildIdeaStatusLines reports loading and budget state', () => {
  const loading = buildIdeaStatusLines({
    provider: 'codex',
    progress: {
      providerQuestionsAsked: 3,
      derailInsistenceCount: 1
    },
    loading: true,
    loadingLabel: 'Analyzing requirements'
  });

  assert.match(loading.join('\n'), /Questions · 3\/8/);
  assert.match(loading.join('\n'), /Derails · 1\/7/);
  assert.match(loading.join('\n'), /Status · Thinking · Analyzing requirements/);
});
