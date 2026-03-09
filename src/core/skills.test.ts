import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempProject } from '../test-support.js';
import { listBuiltinSkills } from './project.js';
import { buildSkillRegistrySnapshot, discoverSkills, internalBuiltinSkillFile, loadSkillFile } from './skills.js';
import { pathExists } from './utils.js';

test('idea internal skill stays hidden from public discovery and registries', async () => {
  const fixture = await createTempProject('ralphi-skills-');

  try {
    const discovered = await discoverSkills(fixture.rootDir);
    const builtin = await listBuiltinSkills();
    const registry = await buildSkillRegistrySnapshot(fixture.rootDir);

    assert.equal(discovered.some(skill => skill.name === 'idea-mode'), false);
    assert.equal(builtin.some(skill => skill.name === 'idea-mode'), false);
    assert.equal(registry.skills.some(skill => skill.name === 'idea-mode'), false);
    assert.equal(registry.content.includes('idea-mode'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('idea internal skill remains loadable through the dedicated internal resolver', async () => {
  const skillFile = internalBuiltinSkillFile('idea-mode');

  assert.equal(await pathExists(skillFile), true);
  const content = await loadSkillFile(skillFile);

  assert.match(content, /Ralphi Idea Mode/);
  assert.match(content, /ask_question/);
  assert.match(content, /ready_to_generate/);
});
