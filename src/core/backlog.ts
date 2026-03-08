import { unlink } from 'node:fs/promises';
import path from 'node:path';

import type { BacklogItem, BacklogSnapshot, BacklogStatus, BacklogStep } from './types.js';
import type { BacklogMarker } from './utils.js';
import { extractJsonBranch, parseJsonFile, pathExists, readText, writeJsonFile } from './utils.js';

interface RalphJsonStory {
  id?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  passes?: boolean;
  notes?: string;
}

interface RalphJsonFile {
  project?: string;
  branchName?: string;
  userStories?: RalphJsonStory[];
}

interface BacklogFile {
  version: number;
  sourcePrd: string;
  branchName: string;
  activeItemId: string | null;
  activeStepId: string | null;
  items: BacklogItem[];
}

interface BacklogPointers {
  activeItemId: string | null;
  activeStepId: string | null;
}

type MarkdownSectionMode = 'stories' | 'requirements' | 'acceptance' | null;

function normalizeItemStatus(value: string | undefined): BacklogStatus {
  if (value === 'done' || value === 'blocked' || value === 'in_progress' || value === 'disabled') {
    return value;
  }

  return 'pending';
}

function normalizeStepStatus(value: string | undefined): BacklogStatus {
  return normalizeItemStatus(value);
}

function enabledItems(items: BacklogItem[]): BacklogItem[] {
  return items.filter(item => item.status !== 'disabled');
}

function enabledSteps(steps: BacklogStep[]): BacklogStep[] {
  return steps.filter(step => step.status !== 'disabled');
}

function nextItemStatus(steps: BacklogStep[], storyDone: boolean): BacklogStatus {
  const activeSteps = enabledSteps(steps);
  if (storyDone || (activeSteps.length > 0 && activeSteps.every(step => step.status === 'done'))) {
    return 'done';
  }

  if (activeSteps.some(step => step.status === 'in_progress')) {
    return 'in_progress';
  }

  if (activeSteps.some(step => step.status === 'blocked')) {
    return 'blocked';
  }

  return 'pending';
}

function nextBacklogItemOrdinal(items: Array<{ id: string }>): number {
  return (
    items.reduce((max, item) => {
      const match = item.id.match(/^BT-(\d+)$/i);
      return Math.max(max, Number(match?.[1] ?? 0));
    }, 0) + 1
  );
}

function buildStepId(itemOrdinal: number, stepOrdinal: number): string {
  return `ST-${String(itemOrdinal).padStart(3, '0')}-${String(stepOrdinal).padStart(2, '0')}`;
}

function normalizeCriteria(criteria: string[] | undefined): string[] {
  return (criteria ?? [])
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => item.replace(/^- \[[ xX]\]\s*/, '').replace(/^- /, '').trim());
}

function createSteps(criteria: string[], itemOrdinal: number): BacklogStep[] {
  return criteria.map((criterion, stepIndex) => ({
    id: buildStepId(itemOrdinal, stepIndex + 1),
    title: criterion,
    status: 'pending'
  }));
}

function normalizeStep(step: BacklogStep, itemOrdinal: number, stepOrdinal: number): BacklogStep {
  return {
    id: step.id?.trim() || buildStepId(itemOrdinal, stepOrdinal),
    title: step.title?.trim() || `Step ${itemOrdinal}.${stepOrdinal}`,
    status: normalizeStepStatus(step.status)
  };
}

function normalizeItem(item: BacklogItem, itemOrdinal: number): BacklogItem {
  const steps = (item.steps ?? []).map((step, stepIndex) => normalizeStep(step, itemOrdinal, stepIndex + 1));
  const requestedStatus = normalizeItemStatus(item.status);
  const status =
    requestedStatus === 'disabled'
      ? 'disabled'
      : requestedStatus === 'done'
        ? 'done'
        : requestedStatus === 'blocked'
          ? 'blocked'
          : requestedStatus === 'in_progress'
            ? 'in_progress'
            : nextItemStatus(steps, false);

  return {
    id: item.id?.trim() || `BT-${String(itemOrdinal).padStart(3, '0')}`,
    storyId: item.storyId?.trim() || `US-${String(itemOrdinal).padStart(3, '0')}`,
    title: item.title?.trim() || `Backlog item ${itemOrdinal}`,
    description: item.description?.trim() || '',
    status,
    notes: item.notes?.trim() || '',
    steps,
    updatedAt: item.updatedAt || new Date().toISOString(),
    source: item.source === 'custom' ? 'custom' : 'prd',
    manualTitle: item.manualTitle?.trim() || null,
    manualDescription: item.manualDescription?.trim() || null
  };
}

function resolvePointers(items: BacklogItem[], activeItemId: string | null, activeStepId: string | null): BacklogPointers {
  const activeCandidate =
    (activeItemId ? items.find(item => item.id === activeItemId && item.status !== 'done' && item.status !== 'disabled') : null) ??
    items.find(item => item.status === 'in_progress') ??
    items.find(item => item.status !== 'done' && item.status !== 'disabled') ??
    null;

  const activeStep =
    (activeStepId
      ? activeCandidate?.steps.find(step => step.id === activeStepId && step.status !== 'done' && step.status !== 'disabled')
      : null) ??
    activeCandidate?.steps.find(step => step.status === 'in_progress') ??
    activeCandidate?.steps.find(step => step.status !== 'done' && step.status !== 'disabled') ??
    null;

  return {
    activeItemId: activeCandidate?.id ?? null,
    activeStepId: activeStep?.id ?? null
  };
}

function normalizeBacklogFile(backlog: BacklogFile | null): BacklogFile | null {
  if (!backlog) {
    return null;
  }

  const items = (backlog.items ?? []).map((item, index) => normalizeItem(item, index + 1));
  const pointers = resolvePointers(items, backlog.activeItemId, backlog.activeStepId);

  return {
    version: 1,
    sourcePrd: backlog.sourcePrd ?? '',
    branchName: backlog.branchName ?? '',
    activeItemId: pointers.activeItemId,
    activeStepId: pointers.activeStepId,
    items
  };
}

function summarize(backlog: BacklogFile): BacklogSnapshot {
  const activeItems = enabledItems(backlog.items);
  const totalItems = activeItems.length;
  const completedItems = activeItems.filter(item => item.status === 'done').length;
  const activeSteps = activeItems.flatMap(item => enabledSteps(item.steps));
  const totalSteps = activeSteps.length;
  const completedSteps = activeSteps.filter(step => step.status === 'done').length;

  return {
    items: backlog.items,
    totalItems,
    completedItems,
    totalSteps,
    completedSteps,
    activeItemId: backlog.activeItemId,
    activeStepId: backlog.activeStepId
  };
}

export function isBacklogComplete(backlog: BacklogSnapshot | null | undefined): boolean {
  if (!backlog) {
    return false;
  }

  return backlog.completedItems >= backlog.totalItems && backlog.completedSteps >= backlog.totalSteps;
}

export async function resetBacklogProgress(backlogPath: string): Promise<BacklogSnapshot | null> {
  const existing = await readExistingBacklog(backlogPath);
  if (!existing) {
    return null;
  }

  const resetItems = existing.items.map(item => ({
    ...item,
    status: item.status === 'disabled' ? ('disabled' as const) : ('pending' as BacklogStatus),
    steps: item.steps.map(step => ({
      ...step,
      status: step.status === 'disabled' ? ('disabled' as const) : ('pending' as BacklogStatus)
    }))
  }));

  const pointers = resolvePointers(resetItems, null, null);
  const reset: BacklogFile = {
    ...existing,
    activeItemId: pointers.activeItemId,
    activeStepId: pointers.activeStepId,
    items: resetItems
  };

  await writeJsonFile(backlogPath, reset);
  return summarize(reset);
}

function mergeBacklog(nextItems: BacklogItem[], existing: BacklogFile | null): BacklogFile {
  const normalizedExisting = normalizeBacklogFile(existing);
  const existingByStoryId = new Map(normalizedExisting?.items.map(item => [item.storyId, item]) ?? []);
  const matchedStoryIds = new Set<string>();

  const mergedItems = nextItems.map((item, index) => {
    const previous = existingByStoryId.get(item.storyId);
    matchedStoryIds.add(item.storyId);

    if (!previous) {
      return normalizeItem(item, index + 1);
    }

    const nextByTitle = new Map(item.steps.map(step => [step.title, step]));
    const stepByTitle = new Map(previous.steps.map(step => [step.title, step]));
    const mergedSteps = item.steps.map(step => {
      const previousStep = stepByTitle.get(step.title);
      return previousStep
        ? {
            ...step,
            id: previousStep.id || step.id,
            status: normalizeStepStatus(previousStep.status)
          }
        : step;
    });

    const status =
      previous.status === 'disabled'
        ? 'disabled'
        : previous.status === 'done'
          ? 'done'
          : previous.status === 'blocked'
            ? 'blocked'
            : nextItemStatus(mergedSteps, false);

    const preservedManualSteps = previous.steps.filter(step => !nextByTitle.has(step.title) && step.status === 'disabled');
    return normalizeItem(
      {
        ...item,
        title: previous.manualTitle?.trim() ? previous.manualTitle : item.title,
        description: previous.manualDescription?.trim() ? previous.manualDescription : item.description,
        status,
        notes: previous.notes,
        updatedAt: previous.updatedAt,
        source: 'prd',
        steps: [...mergedSteps, ...preservedManualSteps],
        manualTitle: previous.manualTitle ?? null,
        manualDescription: previous.manualDescription ?? null
      },
      index + 1
    );
  });

  const preservedCustomItems = (normalizedExisting?.items ?? []).filter(
    item => item.source === 'custom' || !matchedStoryIds.has(item.storyId)
  );
  const items = [...mergedItems, ...preservedCustomItems].map((item, index) => normalizeItem(item, index + 1));
  const pointers = resolvePointers(items, normalizedExisting?.activeItemId ?? null, normalizedExisting?.activeStepId ?? null);

  return {
    version: 1,
    sourcePrd: normalizedExisting?.sourcePrd ?? '',
    branchName: normalizedExisting?.branchName ?? '',
    activeItemId: pointers.activeItemId,
    activeStepId: pointers.activeStepId,
    items
  };
}

function deriveStoryItemsFromJson(parsed: RalphJsonFile): BacklogItem[] {
  const stories = parsed.userStories ?? [];

  return stories.map((story, index) => {
    const itemOrdinal = index + 1;
    const criteria = normalizeCriteria(story.acceptanceCriteria);
    const steps = createSteps(criteria, itemOrdinal);
    const storyDone = story.passes === true;

    return {
      id: `BT-${String(itemOrdinal).padStart(3, '0')}`,
      storyId: story.id ?? `US-${String(itemOrdinal).padStart(3, '0')}`,
      title: story.title?.trim() || `User story ${itemOrdinal}`,
      description: story.description?.trim() || '',
      status: storyDone ? 'done' : nextItemStatus(steps, false),
      notes: story.notes?.trim() || '',
      steps: storyDone ? steps.map(step => ({ ...step, status: 'done' as const })) : steps,
      updatedAt: new Date().toISOString(),
      source: 'prd',
      manualTitle: null,
      manualDescription: null
    };
  });
}

function normalizeMarkdownHeading(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\d+(?:\.\d+)*\s*[.)-]?\s*/, '')
    .trim()
    .toLowerCase();
}

function resolveMarkdownSectionMode(heading: string): MarkdownSectionMode {
  const normalized = normalizeMarkdownHeading(heading);

  if (
    normalized.includes('user stories') ||
    normalized.includes('historias de usuario') ||
    normalized.includes('historias do usuario')
  ) {
    return 'stories';
  }

  if (
    normalized === 'requisitos' ||
    normalized.includes('requisitos funcionais') ||
    normalized.includes('functional requirements') ||
    normalized.includes('requirements')
  ) {
    return 'requirements';
  }

  if (normalized.includes('criterios de aceite') || normalized.includes('acceptance criteria')) {
    return 'acceptance';
  }

  return null;
}

function parseMarkdownItemHeading(
  line: string,
  section: MarkdownSectionMode
): { storyId: string; title: string; fallbackPrefix: 'US' | 'REQ' } | null {
  const explicit = line.match(/^###\s+((?:US|RF|FR|RQ|NFR|CA|AC)-\d+[A-Z]?)(?:\s*[:\-–—]\s*|\s+)(.+)$/i);
  if (explicit) {
    const storyId = explicit[1].trim().toUpperCase();
    return {
      storyId,
      title: explicit[2].trim(),
      fallbackPrefix: storyId.startsWith('US-') ? 'US' : 'REQ'
    };
  }

  if (section !== 'stories' && section !== 'requirements') {
    return null;
  }

  const numbered = line.match(/^###\s+(\d+(?:\.\d+)*)\s*[.)-]?\s+(.+)$/);
  if (numbered) {
    return {
      storyId: `REQ-${numbered[1].replace(/\./g, '-')}`,
      title: numbered[2].trim(),
      fallbackPrefix: section === 'stories' ? 'US' : 'REQ'
    };
  }

  const generic = line.match(/^###\s+(.+)$/);
  if (!generic) {
    return null;
  }

  return {
    storyId: '',
    title: generic[1].trim(),
    fallbackPrefix: section === 'stories' ? 'US' : 'REQ'
  };
}

function deriveStoryItemsFromMarkdown(content: string): BacklogItem[] {
  const lines = content.split(/\r?\n/);
  const items: BacklogItem[] = [];
  const fallbackCriteria: string[] = [];
  let section: MarkdownSectionMode = null;
  let currentTitle = '';
  let currentStoryId = '';
  let currentFallbackPrefix: 'US' | 'REQ' = 'REQ';
  let currentDescriptionLines: string[] = [];
  let currentCriteria: string[] = [];
  let inCriteria = false;

  const flush = () => {
    if (!currentTitle) {
      return;
    }

    const itemOrdinal = items.length + 1;
    const normalizedCriteria = normalizeCriteria(currentCriteria);
    const steps = createSteps(normalizedCriteria, itemOrdinal);
    const descriptionLines = currentDescriptionLines.map(line => line.trim()).filter(Boolean);
    items.push({
      id: `BT-${String(itemOrdinal).padStart(3, '0')}`,
      storyId: currentStoryId || `${currentFallbackPrefix}-${String(itemOrdinal).padStart(3, '0')}`,
      title: currentTitle,
      description: descriptionLines.join(' ') || normalizedCriteria[0] || '',
      status: nextItemStatus(steps, false),
      notes: '',
      steps,
      updatedAt: new Date().toISOString(),
      source: 'prd',
      manualTitle: null,
      manualDescription: null
    });

    currentTitle = '';
    currentStoryId = '';
    currentFallbackPrefix = 'REQ';
    currentDescriptionLines = [];
    currentCriteria = [];
    inCriteria = false;
  };

  for (const line of lines) {
    const sectionHeading = line.match(/^##\s+(.+)$/);
    if (sectionHeading) {
      flush();
      section = resolveMarkdownSectionMode(sectionHeading[1]);
      inCriteria = false;
      continue;
    }

    const itemHeading = parseMarkdownItemHeading(line, section);
    if (itemHeading) {
      flush();
      currentStoryId = itemHeading.storyId;
      currentTitle = itemHeading.title;
      currentFallbackPrefix = itemHeading.fallbackPrefix;
      if (!section) {
        section = itemHeading.fallbackPrefix === 'US' ? 'stories' : 'requirements';
      }
      continue;
    }

    const isBullet = /^\s*[-*]\s+/.test(line) || /^\s*[-*]\s+\[[ xX]\]\s+/.test(line);

    if (section === 'acceptance' && !currentTitle) {
      if (isBullet) {
        fallbackCriteria.push(line.trim());
      }
      continue;
    }

    if (/^\*\*Description:\*\*/i.test(line)) {
      const description = line.replace(/^\*\*Description:\*\*/i, '').trim();
      if (description) {
        currentDescriptionLines.push(description);
      }
      continue;
    }

    if (/^\*\*Acceptance Criteria:\*\*/i.test(line)) {
      inCriteria = true;
      continue;
    }

    if (inCriteria) {
      if (isBullet) {
        currentCriteria.push(line.trim());
        continue;
      }

      if (line.trim() === '') {
        continue;
      }

      inCriteria = false;
    }

    if (!currentTitle) {
      continue;
    }

    if (section === 'requirements' && isBullet) {
      currentCriteria.push(line.trim());
      continue;
    }

    if (line.trim() !== '') {
      currentDescriptionLines.push(line.trim());
    }
  }

  flush();

  if (items.length === 0 && fallbackCriteria.length > 0) {
    const steps = createSteps(normalizeCriteria(fallbackCriteria), 1);
    items.push({
      id: 'BT-001',
      storyId: 'CA-001',
      title: 'Acceptance criteria',
      description: 'Validation checklist derived from the PRD acceptance section.',
      status: nextItemStatus(steps, false),
      notes: '',
      steps,
      updatedAt: new Date().toISOString(),
      source: 'prd',
      manualTitle: null,
      manualDescription: null
    });
  }

  return items;
}

async function readExistingBacklog(backlogPath: string): Promise<BacklogFile | null> {
  return normalizeBacklogFile(await parseJsonFile<BacklogFile>(backlogPath));
}

function applyItemStatus(item: BacklogItem, status: BacklogStatus): BacklogItem {
  if (status === 'disabled') {
    return {
      ...item,
      status: 'disabled',
      steps: item.steps.map(step => ({ ...step, status: 'disabled' })),
      updatedAt: new Date().toISOString()
    };
  }

  if (status === 'done') {
    return {
      ...item,
      status: 'done',
      steps: item.steps.map(step => ({ ...step, status: 'done' })),
      updatedAt: new Date().toISOString()
    };
  }

  if (status === 'in_progress') {
    let assigned = false;
    const steps = item.steps.map(step => {
      if (!assigned && step.status !== 'done' && step.status !== 'disabled') {
        assigned = true;
        return {
          ...step,
          status: 'in_progress' as const
        };
      }

      return step.status === 'disabled'
        ? step
        : {
            ...step,
            status: (step.status === 'done' ? 'done' : 'pending') as BacklogStatus
          };
    });

    return {
      ...item,
      status: 'in_progress',
      steps,
      updatedAt: new Date().toISOString()
    };
  }

  if (status === 'blocked') {
    return {
      ...item,
      status: 'blocked',
      steps: item.steps.map(step =>
        step.status === 'done' || step.status === 'disabled'
          ? step
          : {
              ...step,
              status: 'blocked' as const
            }
      ),
      updatedAt: new Date().toISOString()
    };
  }

  return {
    ...item,
    status: 'pending',
    steps: item.steps.map(step => ({
      ...step,
      status: 'pending' as const
    })),
    updatedAt: new Date().toISOString()
  };
}

function createManualBacklogItem(backlog: BacklogSnapshot, title: string, description: string): BacklogItem {
  const itemOrdinal = nextBacklogItemOrdinal(backlog.items);
  const stepTitle = description.trim() || title.trim();

  return {
    id: `BT-${String(itemOrdinal).padStart(3, '0')}`,
    storyId: `CUSTOM-${String(itemOrdinal).padStart(3, '0')}`,
    title: title.trim(),
    description: description.trim(),
    status: 'pending',
    notes: '',
    steps: [
      {
        id: buildStepId(itemOrdinal, 1),
        title: stepTitle,
        status: 'pending'
      }
    ],
    updatedAt: new Date().toISOString(),
    source: 'custom',
    manualTitle: title.trim(),
    manualDescription: description.trim()
  };
}

function withUpdatedItems(
  backlog: BacklogSnapshot,
  updater: (items: BacklogItem[]) => BacklogItem[],
  pointers?: Partial<BacklogPointers>
): BacklogSnapshot {
  const file = normalizeBacklogFile({
    version: 1,
    sourcePrd: '',
    branchName: '',
    activeItemId: pointers?.activeItemId ?? backlog.activeItemId,
    activeStepId: pointers?.activeStepId ?? backlog.activeStepId,
    items: updater(backlog.items)
  });

  if (!file) {
    return backlog;
  }

  return summarize(file);
}

export function addBacklogItem(backlog: BacklogSnapshot, title: string, description = ''): BacklogSnapshot {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return backlog;
  }

  const item = createManualBacklogItem(backlog, trimmedTitle, description);
  return withUpdatedItems(
    backlog,
    items => [...items, item],
    {
      activeItemId: item.id,
      activeStepId: item.steps[0]?.id ?? null
    }
  );
}

export function editBacklogItem(
  backlog: BacklogSnapshot,
  itemId: string,
  patch: { title?: string; description?: string }
): BacklogSnapshot {
  return withUpdatedItems(backlog, items =>
    items.map(item => {
      if (item.id !== itemId) {
        return item;
      }

      const nextTitle = patch.title?.trim() ?? item.title;
      const nextDescription = patch.description?.trim() ?? item.description;
      const isCustom = item.source === 'custom';
      const shouldRenameSingleStep = item.steps.length === 1 && item.steps[0]?.title.trim() === item.title.trim();
      const steps = shouldRenameSingleStep
        ? item.steps.map(step => ({
            ...step,
            title: nextDescription || nextTitle
          }))
        : item.steps;

      return {
        ...item,
        title: nextTitle,
        description: nextDescription,
        steps,
        updatedAt: new Date().toISOString(),
        manualTitle: isCustom ? nextTitle : nextTitle || null,
        manualDescription: isCustom ? nextDescription : nextDescription || null
      };
    })
  );
}

export function removeBacklogItem(backlog: BacklogSnapshot, itemId: string): BacklogSnapshot {
  return withUpdatedItems(
    backlog,
    items => items.filter(item => item.id !== itemId),
    backlog.activeItemId === itemId
      ? {
          activeItemId: null,
          activeStepId: null
        }
      : undefined
  );
}

export function setBacklogItemStatus(backlog: BacklogSnapshot, itemId: string, status: BacklogStatus): BacklogSnapshot {
  return withUpdatedItems(backlog, items =>
    items.map(item => (item.id === itemId ? applyItemStatus(item, status) : item))
  );
}

export async function ensureBacklogFromPrd(sourcePrd: string, prdJsonPath: string, backlogPath: string): Promise<BacklogSnapshot> {
  const existing = await readExistingBacklog(backlogPath);
  const parsedJson = await parseJsonFile<RalphJsonFile>(prdJsonPath);

  let nextItems: BacklogItem[] = [];
  let branchName = (parsedJson?.branchName ?? '').trim();

  if (parsedJson?.userStories?.length) {
    nextItems = deriveStoryItemsFromJson(parsedJson);
  } else {
    const markdown = await readText(sourcePrd);
    nextItems = deriveStoryItemsFromMarkdown(markdown);
    branchName = branchName || (await extractJsonBranch(prdJsonPath));
  }

  const merged = mergeBacklog(nextItems, existing);
  merged.sourcePrd = sourcePrd;
  merged.branchName = branchName || path.basename(sourcePrd);

  await writeJsonFile(backlogPath, merged);
  return summarize(merged);
}

export async function ensureBacklog(sourcePrd: string, prdJsonPath: string, backlogPath: string): Promise<BacklogSnapshot> {
  if (!(await pathExists(backlogPath))) {
    return ensureBacklogFromPrd(sourcePrd, prdJsonPath, backlogPath);
  }

  const existing = await readExistingBacklog(backlogPath);
  if (!existing) {
    return ensureBacklogFromPrd(sourcePrd, prdJsonPath, backlogPath);
  }

  return summarize(existing);
}

export async function regenerateBacklog(sourcePrd: string, prdJsonPath: string, backlogPath: string): Promise<BacklogSnapshot> {
  await unlink(backlogPath).catch(() => {});
  return ensureBacklogFromPrd(sourcePrd, prdJsonPath, backlogPath);
}

export async function refreshBacklog(sourcePrd: string, prdJsonPath: string, backlogPath: string): Promise<BacklogSnapshot> {
  if (!(await pathExists(prdJsonPath))) {
    return ensureBacklog(sourcePrd, prdJsonPath, backlogPath);
  }

  return ensureBacklogFromPrd(sourcePrd, prdJsonPath, backlogPath);
}

export async function loadBacklog(backlogPath: string): Promise<BacklogSnapshot | null> {
  const existing = await readExistingBacklog(backlogPath);
  if (!existing) {
    return null;
  }

  return summarize(existing);
}

export async function saveBacklogSnapshot(
  backlogPath: string,
  sourcePrd: string,
  branchName: string,
  backlog: BacklogSnapshot
): Promise<void> {
  const file = normalizeBacklogFile({
    version: 1,
    sourcePrd,
    branchName,
    activeItemId: backlog.activeItemId,
    activeStepId: backlog.activeStepId,
    items: backlog.items
  });

  if (!file) {
    return;
  }

  await writeJsonFile(backlogPath, file);
}

export function applyBacklogMarker(backlog: BacklogSnapshot | null, marker: BacklogMarker): BacklogSnapshot | null {
  if (!backlog || !marker.itemId) {
    return backlog;
  }

  const next = withUpdatedItems(
    backlog,
    items =>
      items.map(item => {
        if (item.id !== marker.itemId) {
          return item;
        }

        const steps = item.steps.map(step => {
          if (!marker.stepId || step.id !== marker.stepId || !marker.status) {
            return step;
          }

          return {
            ...step,
            status: marker.status
          };
        });

        const explicitItemStatus = marker.stepId ? null : marker.status;
        const itemStatus =
          explicitItemStatus === 'disabled'
            ? 'disabled'
            : explicitItemStatus === 'done'
              ? 'done'
              : explicitItemStatus === 'blocked'
                ? 'blocked'
                : explicitItemStatus === 'in_progress'
                  ? 'in_progress'
                  : item.status === 'disabled'
                    ? 'disabled'
                    : nextItemStatus(steps, false);

        return {
          ...item,
          status: itemStatus,
          steps,
          updatedAt: new Date().toISOString()
        };
      }),
    {
      activeItemId: marker.itemId ?? backlog.activeItemId,
      activeStepId: marker.stepId ?? backlog.activeStepId
    }
  );

  return next;
}
