import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseJsonFile, readText, writeJsonFile } from './utils.js';

export interface PrdDraftInput {
  title: string;
  description: string;
}

export interface PrdDocument extends PrdDraftInput {
  kind: 'json' | 'markdown';
  content: string;
}

function normalizeTitle(title: string, fallback = 'Untitled PRD'): string {
  return title.trim() || fallback;
}

function normalizeDescription(description: string): string {
  return description.trim();
}

function markdownTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(?:PRD:\s*)?(.+)$/im);
  return normalizeTitle(match?.[1] ?? '', fallback);
}

function extractSection(content: string, heading: 'Introduction' | 'Overview'): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex(line => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line));
  if (startIndex === -1) {
    return '';
  }

  const body: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      break;
    }

    body.push(lines[index]);
  }

  return normalizeDescription(body.join('\n'));
}

function markdownDescription(content: string): string {
  const introduction = extractSection(content, 'Introduction');
  if (introduction) {
    return introduction;
  }

  const overview = extractSection(content, 'Overview');
  if (overview) {
    return overview;
  }

  const firstParagraph = content
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .find(block => !block.startsWith('#'));

  return normalizeDescription(firstParagraph ?? '');
}

function replaceMarkdownSection(content: string, heading: 'Introduction' | 'Overview', nextBody: string): string {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex(line => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line));
  if (startIndex === -1) {
    return content;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  const replacement = [lines[startIndex], '', ...nextBody.trim().split(/\r?\n/)];
  const nextLines = [...lines.slice(0, startIndex), ...replacement, '', ...lines.slice(endIndex)];
  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderPrdMarkdown(input: PrdDraftInput, banner?: string): string {
  const title = normalizeTitle(input.title);
  const description = normalizeDescription(input.description);
  const skillBanner = banner?.trim() ? `${banner.trim()}\n\n` : '';

  return `${skillBanner}# PRD: ${title}

## Introduction

${description}

## Goals

- Define the intended user value clearly.
- Break the work into independently deliverable stories.
- Keep the scope explicit.

## User Stories

### US-001: Define the first deliverable
**Description:** As a user, I want the first increment of this feature so that the team can validate the direction.

**Acceptance Criteria:**
- [ ] The first slice of the feature is explicitly described
- [ ] The implementation boundaries are clear
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Expand this PRD with explicit implementation requirements

## Non-Goals

- Any requirement not described above remains out of scope for this draft

## Success Metrics

- The resulting implementation plan is small enough for iterative agent execution

## Open Questions

- [ ] What constraints or dependencies still need clarification?
`;
}

export async function loadPrdDocument(prdPath: string): Promise<PrdDocument> {
  const parsed = await parseJsonFile<Record<string, unknown>>(prdPath);
  if (parsed) {
    const title =
      typeof parsed.project === 'string'
        ? normalizeTitle(parsed.project, path.basename(prdPath))
        : typeof parsed.title === 'string'
          ? normalizeTitle(parsed.title, path.basename(prdPath))
          : normalizeTitle(path.basename(prdPath), path.basename(prdPath));
    const description =
      typeof parsed.description === 'string'
        ? normalizeDescription(parsed.description)
        : typeof parsed.summary === 'string'
          ? normalizeDescription(parsed.summary)
          : '';

    return {
      title,
      description,
      kind: 'json',
      content: `${JSON.stringify(parsed, null, 2)}\n`
    };
  }

  const content = await readText(prdPath);
  return {
    title: markdownTitle(content, path.basename(prdPath)),
    description: markdownDescription(content),
    kind: 'markdown',
    content
  };
}

export async function savePrdDocument(prdPath: string, input: PrdDraftInput): Promise<void> {
  const title = normalizeTitle(input.title, path.basename(prdPath));
  const description = normalizeDescription(input.description);
  const parsed = await parseJsonFile<Record<string, unknown>>(prdPath);

  if (parsed) {
    await writeJsonFile(prdPath, {
      ...parsed,
      project: title,
      description
    });
    return;
  }

  const current = await readText(prdPath).catch(() => '');
  let next = current;

  if (/^#\s+/m.test(next)) {
    next = next.replace(/^#\s+(?:PRD:\s*)?.+$/im, `# PRD: ${title}`);
  } else {
    next = `# PRD: ${title}\n\n${next.trim()}\n`;
  }

  if (/^##\s+Introduction\s*$/im.test(next)) {
    next = replaceMarkdownSection(next, 'Introduction', description);
  } else if (/^##\s+Overview\s*$/im.test(next)) {
    next = replaceMarkdownSection(next, 'Overview', description);
  } else {
    next = `# PRD: ${title}\n\n## Introduction\n\n${description}\n\n${next.replace(/^#\s+(?:PRD:\s*)?.+$/im, '').trim()}\n`;
  }

  await writeFile(prdPath, next.trimEnd() + '\n', 'utf8');
}
