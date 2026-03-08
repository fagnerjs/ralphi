import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { ensureDir, isJsonFile, writeJsonFile } from './utils.js';

export interface PromptSourceMeta {
  kind: 'template' | 'skill-registry' | 'skill';
  label: string;
  path: string;
}

export interface PromptArtifacts {
  promptPath: string;
  previewPath: string;
  sourcesPath: string;
}

export interface PromptBundle {
  prompt: string;
  preview: string;
  sources: PromptSourceMeta[];
}

export interface BuildPromptOptions {
  rootDir: string;
  ralphDir: string;
  tool: string;
  sourcePrd: string;
  runDir: string;
  prdJsonPath: string;
  progressFilePath: string;
  backlogPath: string;
  workspaceDir: string;
  dependsOnTitle?: string | null;
  dependsOnSourcePrd?: string | null;
  dependsOnBranch?: string | null;
  branchName: string | null;
  baseRef: string | null;
  iteration: number;
  totalIterations: number;
  scheduleMode: string;
  trackLabel: string;
  prdPosition: number;
  prdTotal: number;
  skillRegistry: string;
}

export function resolvePromptArtifactPaths(runDir: string, iteration: number, attempt: number): PromptArtifacts {
  const promptDir = path.join(runDir, 'prompts');
  const prefix = `iteration-${String(iteration).padStart(3, '0')}-attempt-${String(attempt).padStart(2, '0')}`;

  return {
    promptPath: path.join(promptDir, `${prefix}.prompt.md`),
    previewPath: path.join(promptDir, `${prefix}.preview.md`),
    sourcesPath: path.join(promptDir, `${prefix}.sources.json`)
  };
}

export async function buildPrompt(options: BuildPromptOptions): Promise<string> {
  const sourceType = (await isJsonFile(options.sourcePrd)) ? 'json' : 'text/markdown';
  const toWorkspacePath = (targetPath: string): string => {
    const relative = path.relative(options.workspaceDir, targetPath) || '.';
    return relative.startsWith('..') ? targetPath : relative.replaceAll(path.sep, '/');
  };
  const workspaceLabel = '.';
  const sourcePrdPath = toWorkspacePath(options.sourcePrd);
  const runDirPath = toWorkspacePath(options.runDir);
  const prdJsonPath = toWorkspacePath(options.prdJsonPath);
  const progressFilePath = toWorkspacePath(options.progressFilePath);
  const backlogPath = toWorkspacePath(options.backlogPath);
  const dependencySourcePrdPath = options.dependsOnSourcePrd ? toWorkspacePath(options.dependsOnSourcePrd) : 'n/a';
  const dependencyRules = options.dependsOnTitle
    ? `- This PRD depends on ${options.dependsOnTitle}. Treat the implementation already present on ${options.dependsOnBranch ?? 'the dependency branch'} as the baseline and extend it instead of rebuilding the same foundation.
- Inspect the current repository state that came from ${options.dependsOnTitle} before coding, then keep the dependent work compatible with that implementation.
`
    : '';

  return `You are Ralphi, a long-running autonomous coding agent working in the repository at ${options.rootDir}.

Run context:
- Source PRD: ${sourcePrdPath}
- Source type: ${sourceType}
- Provider: ${options.tool}
- Schedule mode: ${options.scheduleMode}
- Current track: ${options.trackLabel}
- PRD position: ${options.prdPosition} of ${options.prdTotal}
- PRD pass: ${options.iteration} of ${options.totalIterations}
- Workspace root for code changes: ${workspaceLabel}
- Branch: ${options.branchName ?? 'shared workspace'}
- Base ref: ${options.baseRef ?? 'n/a'}
- Ralphi directory: ${options.ralphDir}
- Run directory: ${runDirPath}
- PRD JSON path: ${prdJsonPath}
- Progress log: ${progressFilePath}
- Backlog path: ${backlogPath}
- Depends on PRD: ${options.dependsOnTitle ?? 'none'}
- Dependency source PRD: ${dependencySourcePrdPath}
- Dependency branch: ${options.dependsOnBranch ?? 'n/a'}
- This execution is a fresh process. Do not assume memory from prior runs beyond repository files and the persisted state above.

Execution rules:
- Read the source PRD, ${prdJsonPath} when it exists, ${progressFilePath}, and ${backlogPath} before choosing work.
- If the source PRD is not JSON and ${prdJsonPath} is missing, use the local \`ralph\` skill to convert the source PRD into ${prdJsonPath} before implementing anything else.
- If ${backlogPath} is missing or stale after updating ${prdJsonPath}, use the local \`ralphi-backlog\` skill to refresh it.
- Use the local \`ralphi-worktree\` skill whenever you need to reason about isolated worktrees, branch hygiene, or shared orchestration state.
- Make code changes only inside ${workspaceLabel}. Treat the state files in ${runDirPath} as shared orchestration state.
${dependencyRules}- Treat this pass as one complete PRD pass across the backlog, not as a budget for only one backlog item.
- Consume the full configured PRD pass budget. If the backlog is already complete before the final configured pass, use the remaining pass(es) for verification, regression checks, polish, and documentation updates instead of exiting early.
- Work through enabled backlog items in order. When you finish one item, continue to the next incomplete enabled item in the same pass whenever safe progress remains.
- Skip backlog items or steps marked \`disabled\`. Keep the pass pragmatic and verifiable, but do not stop after a single backlog item if more safe work remains.
- Update ${prdJsonPath} after implementation. Completed stories must be marked with \`passes: true\` and concise \`notes\`.
- Update ${backlogPath} as you work. Mark the active backlog item \`in_progress\`, mark finished steps \`done\`, mark each finished item \`done\`, and move \`activeItemId\`/\`activeStepId\` to the next incomplete enabled work item when possible. Preserve any item already marked \`disabled\`.
- Emit concise progress markers whenever you change backlog focus:
  - \`<ralphi-backlog item="BT-001" step="ST-001-01" status="in_progress">\`
  - \`<ralphi-backlog item="BT-001" step="ST-001-03" status="done">\`
- Append a short timestamped entry to ${progressFilePath} describing what was done, what was verified, and what remains.
- Run the most relevant checks from the acceptance criteria when feasible.
- Prefer existing repository patterns and avoid reverting unrelated user changes.
- Treat ${runDirPath} as the persistent state directory for this PRD.
- Emit exactly <promise>COMPLETE</promise> only when all user stories are complete and this is the final configured PRD pass.
- If anything remains, or if this is not the final configured pass yet, do not output that token.

Use the following skill inventory and workflow rules for this run.

${options.skillRegistry}
`;
}

export function redactPromptPreview(prompt: string): string {
  return prompt
    .replace(/((?:api[_ -]?key|token|secret|password)\s*[:=]\s*)([^\s\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(sk-[a-z0-9]{12,}|ghp_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{10,}|AIza[a-z0-9_-]{20,})\b/gi, '[REDACTED]');
}

function dedupeSources(sources: PromptSourceMeta[]): PromptSourceMeta[] {
  const seen = new Set<string>();
  const deduped: PromptSourceMeta[] = [];

  for (const source of sources) {
    const key = `${source.kind}:${source.path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(source);
  }

  return deduped;
}

export async function buildPromptBundle(
  options: BuildPromptOptions & {
    skillRegistryPath: string;
    skillRegistrySources: PromptSourceMeta[];
  }
): Promise<PromptBundle> {
  const prompt = await buildPrompt(options);
  return {
    prompt,
    preview: redactPromptPreview(prompt),
    sources: dedupeSources([
      {
        kind: 'template',
        label: 'Ralphi runtime prompt template',
        path: fileURLToPath(import.meta.url)
      },
      {
        kind: 'skill-registry',
        label: 'Generated skill registry',
        path: options.skillRegistryPath
      },
      ...options.skillRegistrySources
    ])
  };
}

export async function persistPromptBundle(artifacts: PromptArtifacts, bundle: PromptBundle): Promise<void> {
  await ensureDir(path.dirname(artifacts.promptPath));
  await writeFile(artifacts.promptPath, bundle.prompt, 'utf8');
  await writeFile(artifacts.previewPath, bundle.preview, 'utf8');
  await writeJsonFile(artifacts.sourcesPath, bundle.sources);
}
