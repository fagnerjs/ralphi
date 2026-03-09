import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  IDEA_MODE_MAX_DERAIL_INSISTENCE,
  IDEA_MODE_MAX_PROVIDER_QUESTIONS,
  createIdeaPrdBatchDrafts,
  parseIdeaPrdBatchPlan,
  parseIdeaTurnResponse,
  resolveIdeaTurn,
  validateIdeaPrdBatchPlan,
  type IdeaTranscriptEntry
} from './idea.js';
import { createTempProject } from '../test-support.js';
import { pathExists, readText } from './utils.js';

test('parseIdeaTurnResponse accepts ask_question payloads', () => {
  const response = parseIdeaTurnResponse(JSON.stringify({
    action: 'ask_question',
    question: 'Who is the first user for this release?',
    rationale: 'We need a clear primary audience.',
    scopeSummary: null,
    abortReason: null,
    scopeGoal: 'Scope the first release for a notifications feature.',
    latestUserReplyStatus: 'on_topic'
  }));

  assert.equal(response.action, 'ask_question');
  assert.equal(response.question, 'Who is the first user for this release?');
  assert.equal(response.latestUserReplyStatus, 'on_topic');
});

test('parseIdeaTurnResponse accepts fenced ready_to_generate payloads', () => {
  const response = parseIdeaTurnResponse([
    'thinking...',
    '```json',
    JSON.stringify({
      action: 'ready_to_generate',
      question: null,
      rationale: 'Enough scope is available.',
      scopeSummary: 'Generate PRDs for the uploader, processing pipeline, and reporting dashboard.',
      abortReason: null,
      scopeGoal: 'Scope a multi-part media ingest feature.',
      latestUserReplyStatus: 'unclear'
    }),
    '```'
  ].join('\n'));

  assert.equal(response.action, 'ready_to_generate');
  assert.match(response.scopeSummary ?? '', /uploader/);
});

test('parseIdeaTurnResponse rejects malformed outputs', () => {
  assert.throws(
    () => parseIdeaTurnResponse('not-json'),
    /valid JSON/
  );

  assert.throws(
    () => parseIdeaTurnResponse(JSON.stringify({ action: 'ask_question' })),
    /must include a question/
  );
});

test('resolveIdeaTurn tracks question count and enforces the question budget', () => {
  const nextQuestion = resolveIdeaTurn(
    {
      providerQuestionsAsked: IDEA_MODE_MAX_PROVIDER_QUESTIONS - 1,
      derailInsistenceCount: 0
    },
    {
      action: 'ask_question',
      question: 'What is the minimum lovable workflow?',
      rationale: null,
      scopeSummary: null,
      abortReason: null,
      scopeGoal: 'Scope the MVP workflow.',
      latestUserReplyStatus: 'on_topic'
    }
  );

  assert.equal(nextQuestion.status, 'continue');
  assert.equal(nextQuestion.providerQuestionsAsked, IDEA_MODE_MAX_PROVIDER_QUESTIONS);

  const overBudget = resolveIdeaTurn(
    {
      providerQuestionsAsked: IDEA_MODE_MAX_PROVIDER_QUESTIONS,
      derailInsistenceCount: 0
    },
    {
      action: 'ask_question',
      question: 'One more question',
      rationale: 'Need one last detail.',
      scopeSummary: null,
      abortReason: null,
      scopeGoal: 'Scope the release.',
      latestUserReplyStatus: 'on_topic'
    }
  );

  assert.equal(overBudget.status, 'ready');
  assert.equal(overBudget.providerQuestionsAsked, IDEA_MODE_MAX_PROVIDER_QUESTIONS);
  assert.equal(overBudget.response.action, 'ready_to_generate');
});

test('resolveIdeaTurn aborts after the derail insistence limit', () => {
  const aborted = resolveIdeaTurn(
    {
      providerQuestionsAsked: 2,
      derailInsistenceCount: IDEA_MODE_MAX_DERAIL_INSISTENCE - 1
    },
    {
      action: 'ask_question',
      question: 'Can we return to the current feature scope?',
      rationale: 'The last reply drifted away from the original request.',
      scopeSummary: null,
      abortReason: null,
      scopeGoal: 'Scope the analytics dashboard feature.',
      latestUserReplyStatus: 'off_topic'
    }
  );

  assert.equal(aborted.status, 'abort');
  assert.match(aborted.reason, /off-topic replies/);
});

test('validateIdeaPrdBatchPlan normalizes single and multi-PRD plans', () => {
  const single = validateIdeaPrdBatchPlan({
    summary: 'Ship an account security improvement initiative.',
    entries: [
      {
        title: 'Account security hardening',
        summary: 'Add passkey support and recovery safeguards.',
        dependsOn: null
      }
    ]
  });

  assert.equal(single.entries.length, 1);

  const multi = parseIdeaPrdBatchPlan(JSON.stringify({
    summary: 'Ship an ingestion pipeline in three phases.',
    entries: [
      {
        title: 'Uploader foundation',
        summary: 'Create the ingest endpoint and storage handoff.',
        dependsOn: null
      },
      {
        title: 'Processing pipeline',
        summary: 'Process uploaded files asynchronously.',
        dependsOn: 'Uploader foundation'
      }
    ]
  }));

  assert.equal(multi.entries[1]?.dependsOn, 'Uploader foundation');

  assert.throws(
    () => validateIdeaPrdBatchPlan({
      summary: 'Broken plan',
      entries: [
        { title: 'Duplicate', summary: 'First', dependsOn: null },
        { title: 'duplicate', summary: 'Second', dependsOn: null }
      ]
    }),
    /duplicate title/
  );
});

test('createIdeaPrdBatchDrafts creates unique PRDs and dependency suggestions', async () => {
  const fixture = await createTempProject('ralphi-idea-');

  try {
    const existingPath = path.join(fixture.rootDir, 'docs', 'prds', 'prd-uploader-foundation.md');
    await writeFile(existingPath, '# PRD: Existing uploader\n', 'utf8');

    const result = await createIdeaPrdBatchDrafts({
      rootDir: fixture.rootDir,
      plan: {
        summary: 'Ship the ingest pipeline in two PRDs.',
        entries: [
          {
            title: 'Uploader foundation',
            summary: 'Add the ingest endpoint and storage handoff.',
            dependsOn: null
          },
          {
            title: 'Processing pipeline',
            summary: 'Process uploaded files after they land.',
            dependsOn: 'Uploader foundation'
          }
        ]
      }
    });

    assert.equal(result.drafts.length, 2);
    assert.match(path.basename(result.drafts[0]?.path ?? ''), /^prd-uploader-foundation-2\.md$/);
    assert.match(path.basename(result.drafts[1]?.path ?? ''), /^prd-processing-pipeline\.md$/);
    assert.equal(result.dependencySuggestions[result.drafts[1]?.path ?? ''], result.drafts[0]?.path ?? null);

    const firstContent = await readText(result.drafts[0]?.path ?? '');
    assert.match(firstContent, /PRD: Uploader foundation/i);
  } finally {
    await fixture.cleanup();
  }
});

test('createIdeaPrdBatchDrafts rolls back created files when the batch fails', async () => {
  const fixture = await createTempProject('ralphi-idea-');
  const createdPaths: string[] = [];

  try {
    await assert.rejects(
      createIdeaPrdBatchDrafts({
        rootDir: fixture.rootDir,
        plan: {
          summary: 'Create two PRDs and fail on the second.',
          entries: [
            {
              title: 'Foundations',
              summary: 'First PRD summary.',
              dependsOn: null
            },
            {
              title: 'Dependent',
              summary: 'Second PRD summary.',
              dependsOn: 'Foundations'
            }
          ]
        },
        createDraft: async (rootDir, input) => {
          const normalizedInput = typeof input === 'string' ? { title: input } : input;
          const targetPath = path.join(rootDir, 'docs', 'prds', `${normalizedInput.title.toLowerCase()}.md`);
          if (createdPaths.length > 0) {
            throw new Error('simulated draft failure');
          }

          createdPaths.push(targetPath);
          await writeFile(targetPath, `# PRD: ${normalizedInput.title}\n`, 'utf8');
          return targetPath;
        }
      }),
      /rolled back 1 created PRD/
    );

    assert.equal(await pathExists(createdPaths[0] ?? ''), false);
  } finally {
    await fixture.cleanup();
  }
});

test('Idea transcript entries stay serializable for provider replay prompts', () => {
  const transcript: IdeaTranscriptEntry[] = [
    { role: 'assistant', kind: 'status', content: 'Describe the feature you want to scope.' },
    { role: 'user', kind: 'message', content: 'Build a media uploader.' }
  ];

  const serialized = JSON.stringify(transcript);
  assert.match(serialized, /media uploader/);
});
