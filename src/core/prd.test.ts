import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { loadPrdDocument, renderPrdMarkdown, savePrdDocument } from './prd.js';
import { createTempProject } from '../test-support.js';
import { writeJsonFile } from './utils.js';

test('renderPrdMarkdown seeds the title, description, and optional skill banner', () => {
  const markdown = renderPrdMarkdown(
    {
      title: 'Release command center',
      description: 'Coordinate launch steps in one place.'
    },
    '<!-- Seeded with Ralphi skill: planner -->'
  );

  assert.match(markdown, /# PRD: Release command center/);
  assert.match(markdown, /Coordinate launch steps in one place\./);
  assert.match(markdown, /Seeded with Ralphi skill: planner/);
});

test('loadPrdDocument extracts title and introduction from markdown PRDs', async () => {
  const fixture = await createTempProject('ralphi-prd-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(
      prdPath,
      `# PRD: Release console

## Introduction

Track rollout health and approvals.

## Goals

- Keep launches visible
`,
      'utf8'
    );

    const document = await loadPrdDocument(prdPath);

    assert.equal(document.kind, 'markdown');
    assert.equal(document.title, 'Release console');
    assert.equal(document.description, 'Track rollout health and approvals.');
  } finally {
    await fixture.cleanup();
  }
});

test('savePrdDocument rewrites markdown title and introduction while keeping the rest of the PRD', async () => {
  const fixture = await createTempProject('ralphi-prd-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(
      prdPath,
      `# PRD: Old title

## Introduction

Old introduction.

## Goals

- Keep this section
`,
      'utf8'
    );

    await savePrdDocument(prdPath, {
      title: 'New title',
      description: 'New launch overview.'
    });

    const updated = await readFile(prdPath, 'utf8');

    assert.match(updated, /# PRD: New title/);
    assert.match(updated, /## Introduction\n\nNew launch overview\./);
    assert.match(updated, /## Goals\n\n- Keep this section/);
  } finally {
    await fixture.cleanup();
  }
});

test('savePrdDocument updates json PRDs without dropping the existing shape', async () => {
  const fixture = await createTempProject('ralphi-prd-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.json');
    await writeJsonFile(prdPath, {
      project: 'Legacy title',
      description: 'Legacy summary.',
      branchName: 'feature/release-console',
      userStories: []
    });

    await savePrdDocument(prdPath, {
      title: 'Release console',
      description: 'Centralize launch work.'
    });

    const document = await loadPrdDocument(prdPath);

    assert.equal(document.kind, 'json');
    assert.equal(document.title, 'Release console');
    assert.equal(document.description, 'Centralize launch work.');
    assert.match(document.content, /"branchName": "feature\/release-console"/);
  } finally {
    await fixture.cleanup();
  }
});
