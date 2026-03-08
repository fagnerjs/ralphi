import test from 'node:test';
import assert from 'node:assert/strict';

import { sortPlansByDependencies, validatePlanDependencies, wouldCreateDependencyCycle } from './dependencies.js';
import { makePlan } from '../test-support.js';

test('validatePlanDependencies returns a stable topological order', () => {
  const plans = [
    makePlan('/tmp/b.md', { id: 'b', title: 'B', dependsOn: 'a' }),
    makePlan('/tmp/c.md', { id: 'c', title: 'C', dependsOn: null }),
    makePlan('/tmp/a.md', { id: 'a', title: 'A', dependsOn: null })
  ];

  assert.deepEqual(validatePlanDependencies(plans), ['c', 'a', 'b']);
  assert.deepEqual(sortPlansByDependencies(plans).map(plan => plan.id), ['c', 'a', 'b']);
});

test('validatePlanDependencies rejects missing dependencies and cycles', () => {
  assert.throws(
    () =>
      validatePlanDependencies([
        makePlan('/tmp/a.md', { id: 'a', title: 'A', dependsOn: 'missing' })
      ]),
    /not part of this run/
  );

  assert.throws(
    () =>
      validatePlanDependencies([
        makePlan('/tmp/a.md', { id: 'a', title: 'A', dependsOn: 'b' }),
        makePlan('/tmp/b.md', { id: 'b', title: 'B', dependsOn: 'a' })
      ]),
    /contain a cycle/
  );
});

test('wouldCreateDependencyCycle detects invalid dependency edits', () => {
  const plans = [
    makePlan('/tmp/a.md', { id: 'a', title: 'A', dependsOn: null }),
    makePlan('/tmp/b.md', { id: 'b', title: 'B', dependsOn: 'a' }),
    makePlan('/tmp/c.md', { id: 'c', title: 'C', dependsOn: null })
  ];

  assert.equal(wouldCreateDependencyCycle(plans, 'c', 'b'), false);
  assert.equal(wouldCreateDependencyCycle(plans, 'a', 'b'), true);
});
