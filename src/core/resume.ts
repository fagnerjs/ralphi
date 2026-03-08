import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runDoctor } from './doctor.js';
import type {
  RalphConfig,
  RalphFileFingerprint,
  RalphPlanResumeFingerprint,
  RalphSessionResumeFingerprint,
  RalphiRunSession,
  ResumeDriftIssue,
  ResumeDriftReport,
  ResumeSafety
} from './types.js';
import { pathExists, sourceSlug } from './utils.js';

async function fingerprintFile(targetPath: string): Promise<RalphFileFingerprint> {
  if (!(await pathExists(targetPath))) {
    return {
      path: targetPath,
      exists: false,
      sha1: null
    };
  }

  try {
    const content = await readFile(targetPath);
    return {
      path: targetPath,
      exists: true,
      sha1: createHash('sha1').update(content).digest('hex')
    };
  } catch {
    return {
      path: targetPath,
      exists: true,
      sha1: null
    };
  }
}

function resolveRunDir(ralphDir: string, sourcePrd: string, stateKey?: string): string {
  return path.join(ralphDir, 'state', stateKey?.trim() || sourceSlug(sourcePrd));
}

async function planFingerprint(config: RalphConfig, plan: RalphConfig['plans'][number]): Promise<RalphPlanResumeFingerprint> {
  const runDir = resolveRunDir(config.ralphDir, plan.sourcePrd, plan.stateKey);
  const backlogPath = plan.backlogPath ?? path.join(runDir, 'backlog.json');

  return {
    planId: plan.id,
    stateKey: plan.stateKey,
    sourcePrd: await fingerprintFile(plan.sourcePrd),
    backlog: await fingerprintFile(backlogPath)
  };
}

export async function buildSessionResumeFingerprint(config: RalphConfig): Promise<RalphSessionResumeFingerprint> {
  return {
    projectConfig: await fingerprintFile(config.projectConfigPath),
    plans: await Promise.all(config.plans.map(plan => planFingerprint(config, plan)))
  };
}

function classifyResume(issues: ResumeDriftIssue[]): ResumeSafety {
  if (issues.some(issue => issue.severity === 'blocking')) {
    return 'must_restart';
  }

  if (issues.length > 0) {
    return 'warn_resume';
  }

  return 'safe_resume';
}

export async function evaluateResumeDrift(session: RalphiRunSession): Promise<ResumeDriftReport> {
  const issues: ResumeDriftIssue[] = [];
  const currentFingerprint = await buildSessionResumeFingerprint(session.config);
  const savedFingerprint = session.resumeFingerprint;
  const doctor = await runDoctor(session.config);

  for (const check of doctor.checks) {
    if (check.status === 'blocking') {
      issues.push({
        id: `doctor:${check.id}`,
        severity: 'blocking',
        label: check.label,
        detail: check.summary
      });
    }
  }

  if (!savedFingerprint) {
    issues.push({
      id: 'legacy-session',
      severity: 'warning',
      label: 'Legacy session metadata',
      detail: 'This saved run predates resume drift fingerprints. Ralphi can read it, but resume safety is reduced.'
    });
  } else {
    if (!currentFingerprint.projectConfig.exists) {
      issues.push({
        id: 'project-config-missing',
        severity: 'blocking',
        label: '.ralphi.json',
        detail: 'The saved run expects .ralphi.json, but it is missing now.'
      });
    } else if (savedFingerprint.projectConfig.sha1 && currentFingerprint.projectConfig.sha1 !== savedFingerprint.projectConfig.sha1) {
      issues.push({
        id: 'project-config-drift',
        severity: 'warning',
        label: '.ralphi.json drift',
        detail: 'Project config changed since the session was saved.'
      });
    }

    const currentPlansById = new Map(currentFingerprint.plans.map(plan => [plan.planId, plan] as const));
    for (const savedPlan of savedFingerprint.plans) {
      const currentPlan = currentPlansById.get(savedPlan.planId);
      if (!currentPlan) {
        issues.push({
          id: `missing-plan:${savedPlan.planId}`,
          severity: 'blocking',
          label: 'Saved PRD lane missing',
          detail: `The saved plan ${savedPlan.planId} is no longer available.`
        });
        continue;
      }

      if (!currentPlan.sourcePrd.exists) {
        issues.push({
          id: `missing-source:${savedPlan.planId}`,
          severity: 'blocking',
          label: 'Source PRD missing',
          detail: `${path.basename(savedPlan.sourcePrd.path)} is no longer present.`
        });
      } else if (savedPlan.sourcePrd.sha1 && currentPlan.sourcePrd.sha1 !== savedPlan.sourcePrd.sha1) {
        issues.push({
          id: `source-drift:${savedPlan.planId}`,
          severity: 'blocking',
          label: 'Source PRD changed',
          detail: `${path.basename(savedPlan.sourcePrd.path)} changed since this session started.`
        });
      }

      if (savedPlan.backlog.exists && !currentPlan.backlog.exists) {
        issues.push({
          id: `backlog-missing:${savedPlan.planId}`,
          severity: 'warning',
          label: 'Backlog missing',
          detail: `${path.basename(savedPlan.backlog.path)} is missing and may need regeneration.`
        });
      } else if (savedPlan.backlog.sha1 && currentPlan.backlog.sha1 && currentPlan.backlog.sha1 !== savedPlan.backlog.sha1) {
        issues.push({
          id: `backlog-drift:${savedPlan.planId}`,
          severity: 'warning',
          label: 'Backlog drift',
          detail: `${path.basename(savedPlan.backlog.path)} changed since the session was saved.`
        });
      }
    }
  }

  return {
    comparedAt: new Date().toISOString(),
    classification: classifyResume(issues),
    issues
  };
}
