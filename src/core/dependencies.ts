import type { RalphPrdPlan } from './types.js';

type DependencyPlan = Pick<RalphPrdPlan, 'id' | 'title' | 'dependsOn'>;

function stablePlanTitle(plan: DependencyPlan): string {
  return plan.title.trim() || plan.id;
}

function buildPlanMap(plans: DependencyPlan[]): Map<string, DependencyPlan> {
  return new Map(plans.map(plan => [plan.id, plan] as const));
}

export function validatePlanDependencies(plans: DependencyPlan[]): string[] {
  const planMap = buildPlanMap(plans);

  for (const plan of plans) {
    if (!plan.dependsOn) {
      continue;
    }

    if (plan.dependsOn === plan.id) {
      throw new Error(`PRD "${stablePlanTitle(plan)}" cannot depend on itself.`);
    }

    if (!planMap.has(plan.dependsOn)) {
      throw new Error(`PRD "${stablePlanTitle(plan)}" depends on a PRD that is not part of this run.`);
    }
  }

  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const orderIndex = new Map(plans.map((plan, index) => [plan.id, index] as const));

  for (const plan of plans) {
    indegree.set(plan.id, 0);
    dependents.set(plan.id, []);
  }

  for (const plan of plans) {
    if (!plan.dependsOn) {
      continue;
    }

    indegree.set(plan.id, (indegree.get(plan.id) ?? 0) + 1);
    dependents.get(plan.dependsOn)?.push(plan.id);
  }

  const ready = plans.filter(plan => (indegree.get(plan.id) ?? 0) === 0).map(plan => plan.id);
  const sorted: string[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0));
    const nextId = ready.shift();
    if (!nextId) {
      break;
    }

    sorted.push(nextId);
    for (const dependentId of dependents.get(nextId) ?? []) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependentId);
      }
    }
  }

  if (sorted.length !== plans.length) {
    throw new Error('PRD dependencies contain a cycle.');
  }

  return sorted;
}

export function sortPlansByDependencies<T extends DependencyPlan>(plans: T[]): T[] {
  const orderedIds = validatePlanDependencies(plans);
  const planMap = new Map(plans.map(plan => [plan.id, plan] as const));
  return orderedIds.map(planId => planMap.get(planId)).filter((plan): plan is T => Boolean(plan));
}

export function wouldCreateDependencyCycle<T extends DependencyPlan>(plans: T[], planId: string, dependsOn: string | null): boolean {
  try {
    validatePlanDependencies(
      plans.map(plan =>
        plan.id === planId
          ? {
              ...plan,
              dependsOn
            }
          : plan
      )
    );
    return false;
  } catch {
    return true;
  }
}
