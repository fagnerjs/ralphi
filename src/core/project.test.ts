import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import {
  addProjectSkill,
  buildExecutionSkills,
  installLocalSkill,
  loadProjectConfig,
  migrateLegacyProjectRuntime,
  projectConfigPath,
  projectRalphiDir
} from './project.js';
import { pathExists, writeJsonFile } from './utils.js';
import { createTempProject } from '../test-support.js';

test('loadProjectConfig creates a default config when none exists', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    const project = await loadProjectConfig(fixture.rootDir);

    assert.equal(project.created, true);
    assert.equal(project.detected, false);
    assert.equal(project.config.defaults.tool, 'amp');
    assert.equal(project.config.notifications.events.start, true);
    assert.equal(project.config.notifications.channels.slack?.enabled, false);
    assert.equal(await pathExists(projectConfigPath(fixture.rootDir)), true);
  } finally {
    await fixture.cleanup();
  }
});

test('loadProjectConfig migrates legacy local codex skill paths into .codex/skills/public', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    await writeJsonFile(projectConfigPath(fixture.rootDir), {
      version: 1,
      defaults: {
        tool: 'codex'
      },
      skills: [
        {
          id: 'skill-1',
          name: 'release-helper',
          scope: 'project',
          source: 'local',
          target: 'codex',
          path: '.codex/skills/release-helper'
        }
      ]
    });

    const project = await loadProjectConfig(fixture.rootDir);

    assert.equal(project.created, false);
    assert.equal(project.config.skills[0]?.path, '.codex/skills/public/release-helper');
  } finally {
    await fixture.cleanup();
  }
});

test('installLocalSkill and addProjectSkill make local skills available to the selected provider', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    const sourceDir = path.join(fixture.rootDir, 'fixtures', 'release-helper');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '# Release helper\n', 'utf8');

    const installation = await installLocalSkill({
      rootDir: fixture.rootDir,
      name: 'release-helper',
      sourceDir,
      scope: 'project',
      target: 'codex'
    });

    assert.equal(await pathExists(path.join(installation.targetDir, 'SKILL.md')), true);

    const config = await addProjectSkill(fixture.rootDir, {
      id: 'skill-release-helper',
      name: 'release-helper',
      scope: 'project',
      source: 'local',
      target: 'codex',
      path: '.codex/skills/public/release-helper'
    });

    const executionSkills = buildExecutionSkills(fixture.rootDir, 'codex', config);

    assert.equal(executionSkills.length, 1);
    assert.equal(executionSkills[0]?.name, 'release-helper');
    assert.equal(executionSkills[0]?.persisted, true);
    assert.equal(executionSkills[0]?.sourcePath, installation.targetDir);
  } finally {
    await fixture.cleanup();
  }
});

test('migrateLegacyProjectRuntime moves legacy runtime files into .ralphi', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    const legacyStateDir = path.join(fixture.rootDir, 'ralph', 'state', 'release-console');
    const legacyArchiveDir = path.join(fixture.rootDir, 'ralph', 'archive');
    const legacyDraftPath = path.join(fixture.rootDir, 'ralph', 'prd.json');
    await mkdir(legacyStateDir, { recursive: true });
    await mkdir(legacyArchiveDir, { recursive: true });
    await writeJsonFile(path.join(legacyStateDir, 'checkpoint.json'), { status: 'queued' });
    await writeFile(path.join(legacyArchiveDir, 'snapshot.txt'), 'snapshot\n', 'utf8');
    await writeJsonFile(legacyDraftPath, { branchName: 'feature/release-console' });

    await migrateLegacyProjectRuntime(fixture.rootDir);

    assert.equal(await pathExists(path.join(projectRalphiDir(fixture.rootDir), 'state', 'release-console', 'checkpoint.json')), true);
    assert.equal(await pathExists(path.join(projectRalphiDir(fixture.rootDir), 'archive', 'snapshot.txt')), true);
    assert.equal(await pathExists(path.join(projectRalphiDir(fixture.rootDir), 'prd.json')), true);
    assert.equal(await pathExists(legacyDraftPath), false);
  } finally {
    await fixture.cleanup();
  }
});


test('buildExecutionSkills returns no persisted skills for providers without native skill directories', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    const project = await loadProjectConfig(fixture.rootDir);
    const executionSkills = buildExecutionSkills(fixture.rootDir, 'gemini', project.config);

    assert.deepEqual(executionSkills, []);
  } finally {
    await fixture.cleanup();
  }
});


test('buildExecutionSkills supports Copilot skills and skips Cursor native skills', async () => {
  const fixture = await createTempProject('ralphi-project-');

  try {
    const sourceDir = path.join(fixture.rootDir, 'fixtures', 'copilot-release-helper');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '# Release helper\n', 'utf8');

    const installation = await installLocalSkill({
      rootDir: fixture.rootDir,
      name: 'release-helper',
      sourceDir,
      scope: 'project',
      target: 'copilot'
    });

    assert.equal(await pathExists(path.join(installation.targetDir, 'SKILL.md')), true);

    const config = await addProjectSkill(fixture.rootDir, {
      id: 'skill-copilot-release-helper',
      name: 'release-helper',
      scope: 'project',
      source: 'local',
      target: 'copilot',
      path: '.github/skills/release-helper'
    });

    const copilotSkills = buildExecutionSkills(fixture.rootDir, 'copilot', config);
    const cursorSkills = buildExecutionSkills(fixture.rootDir, 'cursor', config);

    assert.equal(copilotSkills.length, 1);
    assert.equal(copilotSkills[0]?.sourcePath, installation.targetDir);
    assert.deepEqual(cursorSkills, []);
  } finally {
    await fixture.cleanup();
  }
});
