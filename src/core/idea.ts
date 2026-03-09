import { rm } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

import type { PrdDraftInput } from './prd.js';
import { projectRalphiDir } from './project.js';
import { createPrdDraftFromBrief, resolvePlanStatePaths, runProviderPrompt } from './runtime.js';
import { builtinSkillFile, internalBuiltinSkillFile, loadSkillFile } from './skills.js';
import type { ProviderName } from './types.js';
import { classifyOutputLine } from './utils.js';

export const IDEA_MODE_INTERNAL_SKILL = 'idea-mode';
export const IDEA_MODE_MAX_PROVIDER_QUESTIONS = 8;
export const IDEA_MODE_MAX_DERAIL_INSISTENCE = 7;

export type IdeaProviderAction = 'ask_question' | 'ready_to_generate' | 'abort_to_menu';
export type IdeaReplyStatus = 'on_topic' | 'off_topic' | 'unclear';
export type IdeaTranscriptRole = 'user' | 'assistant' | 'system';
export type IdeaTranscriptKind = 'message' | 'question' | 'summary' | 'status' | 'error';

export interface IdeaTranscriptEntry {
  role: IdeaTranscriptRole;
  kind: IdeaTranscriptKind;
  content: string;
}

export interface IdeaConversationProgress {
  providerQuestionsAsked: number;
  derailInsistenceCount: number;
}

export interface IdeaTurnResponse {
  action: IdeaProviderAction;
  question: string | null;
  rationale: string | null;
  scopeSummary: string | null;
  abortReason: string | null;
  scopeGoal: string | null;
  latestUserReplyStatus: IdeaReplyStatus;
}

export interface IdeaTurnResolution {
  status: 'continue' | 'ready' | 'abort';
  reason: string;
  providerQuestionsAsked: number;
  derailInsistenceCount: number;
  response: IdeaTurnResponse;
}

export interface IdeaPrdBatchPlanEntry {
  title: string;
  summary: string;
  dependsOn: string | null;
}

export interface IdeaPrdBatchPlan {
  summary: string;
  entries: IdeaPrdBatchPlanEntry[];
}

export interface IdeaCreatedPrdDraft {
  path: string;
  title: string;
  summary: string;
  prdSkillName: string;
}

export interface IdeaCreatedPrdBatch {
  summary: string;
  drafts: IdeaCreatedPrdDraft[];
  dependencySuggestions: Record<string, string | null>;
}

interface RunIdeaConversationTurnOptions {
  rootDir: string;
  provider: ProviderName;
  transcript: IdeaTranscriptEntry[];
  progress: IdeaConversationProgress;
  verbose?: boolean;
  onProgress?: (message: string) => void;
}

interface RunIdeaPrdBatchPlanOptions {
  rootDir: string;
  provider: ProviderName;
  transcript: IdeaTranscriptEntry[];
  verbose?: boolean;
  onProgress?: (message: string) => void;
}

interface CreateIdeaPrdBatchDraftsOptions {
  rootDir: string;
  plan: IdeaPrdBatchPlan;
  provider?: ProviderName;
  prdSkillName?: string;
  prdSkillFilePath?: string;
  verbose?: boolean;
  onProgress?: (message: string) => void;
  createDraft?: typeof createPrdDraftFromBrief;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function maybeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeIdeaKey(value: string): string {
  return value.trim().toLowerCase();
}

function summarizeProviderOutput(output: string, lines = 12): string {
  return output
    .split(/\r?\n/)
    .map(line => stripVTControlCharacters(line).trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

function parseJsonValue(candidate: string): unknown | null {
  const trimmed = stripVTControlCharacters(candidate).trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractJsonRecordFromOutput(output: string): Record<string, unknown> {
  const direct = parseJsonValue(output);
  if (isRecord(direct)) {
    return direct;
  }

  const fencedMatches = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let index = fencedMatches.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonValue(fencedMatches[index]?.[1] ?? '');
    if (isRecord(parsed)) {
      return parsed;
    }
  }

  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonValue(lines[index] ?? '');
    if (isRecord(parsed)) {
      return parsed;
    }
  }

  const objectStart = output.lastIndexOf('{');
  const objectEnd = output.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    const parsed = parseJsonValue(output.slice(objectStart, objectEnd + 1));
    if (isRecord(parsed)) {
      return parsed;
    }
  }

  throw new Error('Idea mode provider output was not valid JSON.');
}

function formatTranscript(transcript: IdeaTranscriptEntry[]): string {
  const normalized = transcript
    .map((entry, index) => {
      const role = entry.role.toUpperCase();
      const kind = entry.kind.toUpperCase();
      return `${index + 1}. ${role} [${kind}]\n${entry.content.trim()}`;
    })
    .join('\n\n');

  return normalized || 'No transcript available yet.';
}

export function buildIdeaConversationPrompt(
  rootDir: string,
  transcript: IdeaTranscriptEntry[],
  progress: IdeaConversationProgress,
  skillContent: string
): string {
  const remainingQuestions = Math.max(0, IDEA_MODE_MAX_PROVIDER_QUESTIONS - progress.providerQuestionsAsked);

  return `You are Ralphi's internal Idea mode worker inside the repository at ${rootDir}.

Task:
- Review the Idea transcript below.
- Decide whether to ask one focused follow-up question, declare the scope ready for PRD creation, or abort back to the launch menu.
- Use the internal skill below as the primary behavior contract.

Session limits:
- Provider questions already asked: ${progress.providerQuestionsAsked}
- Remaining provider questions: ${remainingQuestions}
- Off-topic insistence count so far: ${progress.derailInsistenceCount}
- Abort threshold for off-topic insistence: ${IDEA_MODE_MAX_DERAIL_INSISTENCE}

Constraints:
- Ask at most one question.
- Never return free-form prose outside the JSON object.
- If remaining provider questions is 0, you must not return ask_question.
- Judge the latest user reply as on_topic, off_topic, or unclear.
- If the latest user reply is off-topic, briefly correct it through rationale or scopeGoal and steer back to the feature scope.
- Do not create PRDs yet.
- Do not brainstorm unrelated ideas.

Response contract:
{
  "action": "ask_question" | "ready_to_generate" | "abort_to_menu",
  "question": "One focused question" | null,
  "rationale": "Short reason" | null,
  "scopeSummary": "Concise scoped summary" | null,
  "abortReason": "Why the session should end" | null,
  "scopeGoal": "Current feature goal" | null,
  "latestUserReplyStatus": "on_topic" | "off_topic" | "unclear"
}

Transcript:
${formatTranscript(transcript)}

Internal skill instructions:
${skillContent}

Return only the JSON object.`;
}

export function parseIdeaTurnResponse(output: string): IdeaTurnResponse {
  const record = extractJsonRecordFromOutput(output);
  const action = maybeString(record.action);
  if (action !== 'ask_question' && action !== 'ready_to_generate' && action !== 'abort_to_menu') {
    throw new Error('Idea mode returned an unsupported action.');
  }

  const latestUserReplyStatus = maybeString(record.latestUserReplyStatus);
  const normalizedReplyStatus: IdeaReplyStatus =
    latestUserReplyStatus === 'on_topic' || latestUserReplyStatus === 'off_topic' || latestUserReplyStatus === 'unclear'
      ? latestUserReplyStatus
      : 'unclear';

  const response: IdeaTurnResponse = {
    action,
    question: maybeString(record.question),
    rationale: maybeString(record.rationale),
    scopeSummary: maybeString(record.scopeSummary),
    abortReason: maybeString(record.abortReason),
    scopeGoal: maybeString(record.scopeGoal),
    latestUserReplyStatus: normalizedReplyStatus
  };

  if (response.action === 'ask_question' && !response.question) {
    throw new Error('Idea mode ask_question responses must include a question.');
  }

  if (response.action === 'ready_to_generate' && !response.scopeSummary) {
    throw new Error('Idea mode ready_to_generate responses must include a scopeSummary.');
  }

  if (response.action === 'abort_to_menu' && !response.abortReason) {
    throw new Error('Idea mode abort_to_menu responses must include an abortReason.');
  }

  return response;
}

export function resolveIdeaTurn(progress: IdeaConversationProgress, response: IdeaTurnResponse): IdeaTurnResolution {
  const nextDerailInsistenceCount =
    response.latestUserReplyStatus === 'off_topic'
      ? progress.derailInsistenceCount + 1
      : progress.derailInsistenceCount;

  if (nextDerailInsistenceCount >= IDEA_MODE_MAX_DERAIL_INSISTENCE) {
    return {
      status: 'abort',
      reason: `Idea mode ended after ${nextDerailInsistenceCount} off-topic replies. Start again with one concrete feature scope.`,
      providerQuestionsAsked: progress.providerQuestionsAsked,
      derailInsistenceCount: nextDerailInsistenceCount,
      response
    };
  }

  if (response.action === 'abort_to_menu') {
    return {
      status: 'abort',
      reason: response.abortReason ?? 'Idea mode aborted and returned to the launch menu.',
      providerQuestionsAsked: progress.providerQuestionsAsked,
      derailInsistenceCount: nextDerailInsistenceCount,
      response
    };
  }

  if (response.action === 'ask_question') {
    if (progress.providerQuestionsAsked >= IDEA_MODE_MAX_PROVIDER_QUESTIONS) {
      return {
        status: 'ready',
        reason: response.scopeSummary ?? 'Idea mode reached its question limit. PRD creation is starting with the current scope.',
        providerQuestionsAsked: progress.providerQuestionsAsked,
        derailInsistenceCount: nextDerailInsistenceCount,
        response: {
          ...response,
          action: 'ready_to_generate',
          scopeSummary:
            response.scopeSummary ?? response.rationale ?? response.scopeGoal ?? 'Use the current transcript as the best available scoped summary.'
        }
      };
    }

    return {
      status: 'continue',
      reason: response.question ?? 'Continue the Idea conversation.',
      providerQuestionsAsked: progress.providerQuestionsAsked + 1,
      derailInsistenceCount: nextDerailInsistenceCount,
      response
    };
  }

  return {
    status: 'ready',
    reason: response.scopeSummary ?? 'Idea scope is ready for PRD creation.',
    providerQuestionsAsked: progress.providerQuestionsAsked,
    derailInsistenceCount: nextDerailInsistenceCount,
    response
  };
}

export async function runIdeaConversationTurn(options: RunIdeaConversationTurnOptions): Promise<IdeaTurnResponse> {
  const skillContent = await loadSkillFile(internalBuiltinSkillFile(IDEA_MODE_INTERNAL_SKILL));
  let lastProgress = '';
  const result = await runProviderPrompt({
    provider: options.provider,
    workspaceDir: options.rootDir,
    verbose: options.verbose,
    mode: 'planning',
    onOutputLine: line => {
      const next = classifyOutputLine(line);
      if (next && next !== lastProgress) {
        lastProgress = next;
        options.onProgress?.(next);
      }
    },
    prompt: buildIdeaConversationPrompt(options.rootDir, options.transcript, options.progress, skillContent)
  });

  if (result.exitCode !== 0) {
    const summary = summarizeProviderOutput(result.output);
    throw new Error(summary ? `Idea mode failed.\n${summary}` : 'Idea mode failed.');
  }

  return parseIdeaTurnResponse(result.output);
}

export function buildIdeaPrdBatchPlanPrompt(rootDir: string, transcript: IdeaTranscriptEntry[], skillContent: string): string {
  return `You are Ralphi's internal Idea mode worker inside the repository at ${rootDir}.

Task:
- Convert the scoped Idea transcript into one or more implementation-ready PRD briefs.
- Return a single JSON batch plan.
- Use the internal skill below as the primary behavior contract.

Constraints:
- Return only JSON.
- Do not ask follow-up questions.
- Do not create PRD files yet.
- Keep titles unique.
- Use dependsOn as null or the exact title of another entry.
- Split into multiple PRDs only when the scope naturally separates into deliverables with independent value.
- Keep summaries concise but specific enough for downstream PRD generation.

Batch plan contract:
{
  "summary": "Short initiative summary",
  "entries": [
    {
      "title": "PRD title",
      "summary": "Implementation-ready brief",
      "dependsOn": null | "Exact title of another entry"
    }
  ]
}

Transcript:
${formatTranscript(transcript)}

Internal skill instructions:
${skillContent}

Return only the JSON object.`;
}

export function validateIdeaPrdBatchPlan(value: unknown): IdeaPrdBatchPlan {
  const record = isRecord(value) ? value : null;
  const summary = maybeString(record?.summary);
  const entries = Array.isArray(record?.entries) ? record.entries : null;

  if (!summary) {
    throw new Error('Idea PRD batch plan must include a top-level summary.');
  }

  if (!entries || entries.length === 0) {
    throw new Error('Idea PRD batch plan must include at least one PRD entry.');
  }

  const normalizedEntries = entries.map((entry, index) => {
    const normalized = isRecord(entry) ? entry : null;
    const title = maybeString(normalized?.title);
    const entrySummary = maybeString(normalized?.summary);
    const dependsOn = maybeString(normalized?.dependsOn);

    if (!title) {
      throw new Error(`Idea PRD batch entry ${index + 1} is missing a title.`);
    }

    if (!entrySummary) {
      throw new Error(`Idea PRD batch entry ${index + 1} is missing a summary.`);
    }

    if (dependsOn && normalizeIdeaKey(dependsOn) === normalizeIdeaKey(title)) {
      throw new Error(`Idea PRD batch entry "${title}" cannot depend on itself.`);
    }

    return {
      title,
      summary: entrySummary,
      dependsOn: dependsOn ?? null
    } satisfies IdeaPrdBatchPlanEntry;
  });

  const seenTitles = new Set<string>();
  for (const entry of normalizedEntries) {
    const key = normalizeIdeaKey(entry.title);
    if (seenTitles.has(key)) {
      throw new Error(`Idea PRD batch plan contains duplicate title "${entry.title}".`);
    }

    seenTitles.add(key);
  }

  const titleMap = new Map(normalizedEntries.map(entry => [normalizeIdeaKey(entry.title), entry] as const));
  for (const entry of normalizedEntries) {
    if (!entry.dependsOn) {
      continue;
    }

    if (!titleMap.has(normalizeIdeaKey(entry.dependsOn))) {
      throw new Error(`Idea PRD batch entry "${entry.title}" depends on missing title "${entry.dependsOn}".`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (title: string): void => {
    if (visited.has(title)) {
      return;
    }

    if (visiting.has(title)) {
      throw new Error('Idea PRD batch plan dependencies cannot create a cycle.');
    }

    visiting.add(title);
    const entry = titleMap.get(title);
    if (entry?.dependsOn) {
      walk(normalizeIdeaKey(entry.dependsOn));
    }
    visiting.delete(title);
    visited.add(title);
  };

  for (const entry of normalizedEntries) {
    walk(normalizeIdeaKey(entry.title));
  }

  return {
    summary,
    entries: normalizedEntries
  };
}

export function parseIdeaPrdBatchPlan(output: string): IdeaPrdBatchPlan {
  return validateIdeaPrdBatchPlan(extractJsonRecordFromOutput(output));
}

export async function runIdeaPrdBatchPlan(options: RunIdeaPrdBatchPlanOptions): Promise<IdeaPrdBatchPlan> {
  const skillContent = await loadSkillFile(internalBuiltinSkillFile(IDEA_MODE_INTERNAL_SKILL));
  let lastProgress = '';
  const result = await runProviderPrompt({
    provider: options.provider,
    workspaceDir: options.rootDir,
    verbose: options.verbose,
    mode: 'planning',
    onOutputLine: line => {
      const next = classifyOutputLine(line);
      if (next && next !== lastProgress) {
        lastProgress = next;
        options.onProgress?.(next);
      }
    },
    prompt: buildIdeaPrdBatchPlanPrompt(options.rootDir, options.transcript, skillContent)
  });

  if (result.exitCode !== 0) {
    const summary = summarizeProviderOutput(result.output);
    throw new Error(summary ? `Idea PRD batch planning failed.\n${summary}` : 'Idea PRD batch planning failed.');
  }

  return parseIdeaPrdBatchPlan(result.output);
}

export async function createIdeaPrdBatchDrafts(options: CreateIdeaPrdBatchDraftsOptions): Promise<IdeaCreatedPrdBatch> {
  const plan = validateIdeaPrdBatchPlan(options.plan);
  const createDraft = options.createDraft ?? createPrdDraftFromBrief;
  const skillName = options.prdSkillName?.trim() || (options.provider ? 'prd' : 'template');
  const createdDrafts: IdeaCreatedPrdDraft[] = [];
  const rootRalphDir = projectRalphiDir(options.rootDir);

  try {
    for (let index = 0; index < plan.entries.length; index += 1) {
      const entry = plan.entries[index];
      const prefix = `Creating PRD ${index + 1}/${plan.entries.length}: ${entry.title}`;

      options.onProgress?.(prefix);

      const draftInput: PrdDraftInput = {
        title: entry.title,
        description: entry.summary
      };

      const draftPath =
        options.provider && (options.prdSkillFilePath ?? builtinSkillFile('prd'))
          ? await createDraft(options.rootDir, draftInput, {
              skillName,
              skillFilePath: options.prdSkillFilePath ?? builtinSkillFile('prd'),
              provider: options.provider,
              verbose: options.verbose,
              onProgress: progress => {
                options.onProgress?.(`${prefix} · ${progress}`);
              }
            })
          : await createDraft(options.rootDir, draftInput);

      createdDrafts.push({
        path: draftPath,
        title: entry.title,
        summary: entry.summary,
        prdSkillName: skillName
      });
    }
  } catch (error) {
    await Promise.all(
      createdDrafts.map(async draft => {
        await rm(draft.path, { force: true }).catch(() => undefined);
        const paths = resolvePlanStatePaths(rootRalphDir, draft.path);
        await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
      })
    );

    const message = error instanceof Error ? error.message : 'Unable to create the PRD batch.';
    throw new Error(
      createdDrafts.length > 0
        ? `Idea PRD batch creation failed and rolled back ${createdDrafts.length} created PRD${createdDrafts.length === 1 ? '' : 's'}. ${message}`
        : `Idea PRD batch creation failed. ${message}`
    );
  }

  const pathByTitle = new Map(createdDrafts.map(draft => [normalizeIdeaKey(draft.title), draft.path] as const));
  const dependencySuggestions = Object.fromEntries(
    plan.entries.map(entry => [
      pathByTitle.get(normalizeIdeaKey(entry.title)) ?? entry.title,
      entry.dependsOn ? pathByTitle.get(normalizeIdeaKey(entry.dependsOn)) ?? null : null
    ])
  ) as Record<string, string | null>;

  return {
    summary: plan.summary,
    drafts: createdDrafts,
    dependencySuggestions
  };
}
