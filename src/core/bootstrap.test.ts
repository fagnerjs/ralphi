import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { applyProjectBootstrap, inspectProjectBootstrap } from './bootstrap.js';
import { createTempProject } from '../test-support.js';

test('inspectProjectBootstrap reports recommended and optional scaffolds for a fresh project', async () => {
  const fixture = await createTempProject('ralphi-bootstrap-');

  try {
    const inspection = await inspectProjectBootstrap(fixture.rootDir);
    const itemIds = new Set(inspection.items.map(item => item.id));

    assert.equal(inspection.devcontainerConfigPath, null);
    assert.ok(itemIds.has('agents-md'));
    assert.ok(itemIds.has('claude-md'));
    assert.ok(itemIds.has('copilot-instructions'));
    assert.ok(itemIds.has('copilot-path-instructions'));
    assert.ok(itemIds.has('cursor-rules'));
    assert.ok(itemIds.has('ralphi-state-gitignore'));
    assert.ok(itemIds.has('claude-local-gitignore'));
    assert.ok(itemIds.has('codex-skill-dir'));
    assert.ok(itemIds.has('claude-skill-dir'));
    assert.ok(itemIds.has('devcontainer'));

    const devcontainerItem = inspection.items.find(item => item.id === 'devcontainer');
    assert.equal(devcontainerItem?.recommended, false);
  } finally {
    await fixture.cleanup();
  }
});

test('applyProjectBootstrap clears recommended scaffolds while leaving optional extras available', async () => {
  const fixture = await createTempProject('ralphi-bootstrap-');

  try {
    const inspection = await applyProjectBootstrap(fixture.rootDir, [
      'agents-md',
      'claude-md',
      'ralphi-state-gitignore',
      'claude-local-gitignore'
    ]);

    const agentsContent = await readFile(path.join(fixture.rootDir, 'AGENTS.md'), 'utf8');
    const claudeContent = await readFile(path.join(fixture.rootDir, 'CLAUDE.md'), 'utf8');
    const gitignoreContent = await readFile(path.join(fixture.rootDir, '.gitignore'), 'utf8');

    assert.match(agentsContent, /Install dependencies with `npm install` before coding\./);
    assert.match(claudeContent, /## Workflow/);
    assert.match(gitignoreContent, /\.ralphi\//);
    assert.match(gitignoreContent, /\.claude\/settings\.local\.json/);
    assert.ok(inspection.items.length > 0);
    assert.ok(inspection.items.every(item => item.recommended === false));
  } finally {
    await fixture.cleanup();
  }
});

test('applyProjectBootstrap creates Copilot and Cursor starter files', async () => {
  const fixture = await createTempProject('ralphi-bootstrap-');

  try {
    const inspection = await applyProjectBootstrap(fixture.rootDir, [
      'copilot-instructions',
      'copilot-path-instructions',
      'cursor-rules'
    ]);
    const copilotPath = path.join(fixture.rootDir, '.github', 'copilot-instructions.md');
    const copilotPathInstructionsPath = path.join(fixture.rootDir, '.github', 'instructions', 'code.instructions.md');
    const cursorRulePath = path.join(fixture.rootDir, '.cursor', 'rules', 'ralphi-project.mdc');
    const copilotContent = await readFile(copilotPath, 'utf8');
    const copilotPathInstructionsContent = await readFile(copilotPathInstructionsPath, 'utf8');
    const cursorRuleContent = await readFile(cursorRulePath, 'utf8');

    assert.match(copilotContent, /# Copilot Instructions/);
    assert.match(copilotContent, /Read AGENTS\.md before large changes when it exists\./);
    assert.match(copilotPathInstructionsContent, /^---\napplyTo: /);
    assert.match(copilotPathInstructionsContent, /# Path-specific Copilot instructions/);
    assert.match(copilotPathInstructionsContent, /Keep edits focused on the matching code paths/);
    assert.match(cursorRuleContent, /description: Project-wide guidance/);
    assert.match(cursorRuleContent, /alwaysApply: true/);
    assert.equal(inspection.items.some(item => item.id === 'copilot-instructions'), false);
    assert.equal(inspection.items.some(item => item.id === 'copilot-path-instructions'), false);
    assert.equal(inspection.items.some(item => item.id === 'cursor-rules'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('applyProjectBootstrap creates a devcontainer and updates the detected config path', async () => {
  const fixture = await createTempProject('ralphi-bootstrap-');

  try {
    const inspection = await applyProjectBootstrap(fixture.rootDir, ['devcontainer']);
    const targetPath = path.join(fixture.rootDir, '.devcontainer', 'devcontainer.json');
    const content = await readFile(targetPath, 'utf8');

    assert.equal(inspection.devcontainerConfigPath, targetPath);
    assert.equal(inspection.items.some(item => item.id === 'devcontainer'), false);
    assert.match(content, /"name": "Ralphi workspace"/);
  } finally {
    await fixture.cleanup();
  }
});
