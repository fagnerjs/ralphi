import path from 'node:path';
import { rm } from 'node:fs/promises';

import { buildSessionResumeFingerprint } from './resume.js';
import type { RalphConfig, RalphContextSnapshot, RalphiRunSession, RalphiRunSessionStatus } from './types.js';
import { ensureDir, parseJsonFile, sourceSlug, writeJsonFile } from './utils.js';

const RUN_SESSION_VERSION = 3;

function stateDir(ralphDir: string): string {
  return path.join(ralphDir, 'state');
}

export function runSessionPath(ralphDir: string): string {
  return path.join(stateDir(ralphDir), 'session.json');
}

export function contextCheckpointPath(runDir: string): string {
  return path.join(runDir, 'checkpoint.json');
}

function resolveRunDir(ralphDir: string, sourcePrd: string, stateKey?: string): string {
  const runSlug = stateKey?.trim() || sourceSlug(sourcePrd);
  return path.join(stateDir(ralphDir), runSlug);
}

export async function saveRunSession(
  ralphDir: string,
  config: RalphConfig,
  status: RalphiRunSessionStatus,
  summary: RalphiRunSession['summary'] = null
): Promise<RalphiRunSession> {
  await ensureDir(stateDir(ralphDir));
  const existing = await parseJsonFile<RalphiRunSession>(runSessionPath(ralphDir));
  const resumeFingerprint = await buildSessionResumeFingerprint(config).catch(() => null);
  const session: RalphiRunSession = {
    version: RUN_SESSION_VERSION,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    config,
    summary,
    resumeFingerprint
  };
  await writeJsonFile(runSessionPath(ralphDir), session);
  return session;
}

export async function loadRunSession(ralphDir: string): Promise<RalphiRunSession | null> {
  const parsed = await parseJsonFile<RalphiRunSession>(runSessionPath(ralphDir));
  if (!parsed || !parsed.config || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== RUN_SESSION_VERSION)) {
    return null;
  }

  return {
    version: RUN_SESSION_VERSION,
    createdAt: parsed.createdAt ?? new Date(0).toISOString(),
    updatedAt: parsed.updatedAt ?? parsed.createdAt ?? new Date(0).toISOString(),
    status: parsed.status ?? 'blocked',
    config: parsed.config,
    summary: parsed.summary
      ? {
          ...parsed.summary,
          finalBranchName: parsed.summary.finalBranchName ?? null
        }
      : null,
    resumeFingerprint: parsed.resumeFingerprint ?? null
  };
}

export async function loadPendingRunSession(ralphDir: string): Promise<RalphiRunSession | null> {
  const session = await loadRunSession(ralphDir);
  if (!session) {
    return null;
  }

  if (session.status === 'complete' || session.summary?.completed) {
    return null;
  }

  if (!session.config.plans || session.config.plans.length === 0) {
    return null;
  }

  return session;
}

export async function clearRunSession(ralphDir: string): Promise<void> {
  await rm(runSessionPath(ralphDir), { force: true });
}

export async function saveContextCheckpoint(snapshot: RalphContextSnapshot): Promise<void> {
  await ensureDir(snapshot.runDir);
  await writeJsonFile(contextCheckpointPath(snapshot.runDir), snapshot);
}

export async function loadContextCheckpoint(runDir: string): Promise<RalphContextSnapshot | null> {
  return parseJsonFile<RalphContextSnapshot>(contextCheckpointPath(runDir));
}

export async function listCheckpointSnapshots(config: RalphConfig): Promise<RalphContextSnapshot[]> {
  const checkpoints = await Promise.all(
    config.plans.map(plan => loadContextCheckpoint(resolveRunDir(config.ralphDir, plan.sourcePrd, plan.stateKey)))
  );

  return checkpoints.filter((checkpoint): checkpoint is RalphContextSnapshot => Boolean(checkpoint));
}

export async function clearRunState(config: RalphConfig): Promise<void> {
  const deletions = config.plans.map(plan =>
    rm(resolveRunDir(config.ralphDir, plan.sourcePrd, plan.stateKey), { recursive: true, force: true })
  );
  await Promise.all([...deletions, clearRunSession(config.ralphDir)]);
}

export async function prepareContextRetry(runDir: string): Promise<RalphContextSnapshot | null> {
  const checkpoint = await loadContextCheckpoint(runDir);
  if (!checkpoint?.lastFailure?.retryable || checkpoint.lastFailure.retryCount >= 1) {
    return null;
  }

  checkpoint.iterationsRun = Math.max(0, checkpoint.iterationsRun - 1);
  checkpoint.status = 'queued';
  checkpoint.done = false;
  checkpoint.lastError = null;
  checkpoint.lastStep = 'Retry requested';
  checkpoint.lastFailure = {
    ...checkpoint.lastFailure,
    retryCount: checkpoint.lastFailure.retryCount + 1
  };

  await saveContextCheckpoint(checkpoint);
  return checkpoint;
}
