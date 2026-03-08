import { stripVTControlCharacters } from 'node:util';

import type { ProviderName } from './types.js';

export interface ProviderOutputObservation {
  displayLines: string[];
  isStructured: boolean;
  sessionId: string | null;
  threadId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonLine(line: string): unknown | null {
  const sanitized = stripVTControlCharacters(line).trim();
  if (!sanitized.startsWith('{') && !sanitized.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(sanitized) as unknown;
  } catch {
    return null;
  }
}

function splitDisplayText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  for (const line of lines) {
    if (!line || seen.has(line)) {
      continue;
    }

    seen.add(line);
    next.push(line);
  }

  return next;
}

function maybeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toolName(record: Record<string, unknown>): string | null {
  const direct = [record.name, record.tool_name, record.tool, record.call_name].map(maybeString).find(Boolean);
  if (direct) {
    return direct;
  }

  const toolCall = isRecord(record.toolCall) ? record.toolCall : null;
  return [toolCall?.name, toolCall?.tool].map(maybeString).find(Boolean) ?? null;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return splitDisplayText(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectText(item, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const record = value;
  const type = maybeString(record.type);

  if (type === 'text' || type === 'reasoning') {
    return uniqueLines([
      ...collectText(record.text, depth + 1),
      ...collectText(record.content, depth + 1),
      ...collectText(record.delta, depth + 1)
    ]);
  }

  if (type === 'tool_use' || type === 'tool-call' || type === 'tool_call') {
    const name = toolName(record);
    return name ? [`Tool: ${name}`] : [];
  }

  if (type === 'tool_result') {
    return uniqueLines([
      ...collectText(record.output, depth + 1),
      ...collectText(record.result, depth + 1),
      ...collectText(record.content, depth + 1),
      ...collectText(record.error, depth + 1)
    ]);
  }

  if (type === 'error') {
    return uniqueLines([
      ...collectText(record.message, depth + 1),
      ...collectText(record.error, depth + 1),
      ...collectText(record.summary, depth + 1)
    ]);
  }

  const prioritizedKeys = ['text', 'message', 'content', 'result', 'output', 'error', 'summary', 'delta'];
  const lines: string[] = [];

  for (const key of prioritizedKeys) {
    if (record[key] !== undefined) {
      lines.push(...collectText(record[key], depth + 1));
    }
  }

  return uniqueLines(lines);
}

function observeAnthropicLike(value: unknown): ProviderOutputObservation {
  const record = isRecord(value) ? value : null;
  const sessionId = maybeString(record?.session_id) ?? null;
  const displayLines = uniqueLines(
    collectText(record?.message ?? record?.content ?? record?.result ?? record?.error ?? record)
  );

  return {
    displayLines,
    isStructured: true,
    sessionId,
    threadId: null
  };
}

function observeGeminiLike(value: unknown): ProviderOutputObservation {
  const record = isRecord(value) ? value : null;
  const sessionId = maybeString(record?.session_id) ?? null;
  const type = maybeString(record?.type);

  let displayLines: string[] = [];
  if (type === 'tool_use') {
    const name = record ? toolName(record) : null;
    displayLines = name ? [`Tool: ${name}`] : [];
  } else {
    displayLines = uniqueLines(collectText(record));
  }

  return {
    displayLines,
    isStructured: true,
    sessionId,
    threadId: null
  };
}

function observeCodex(value: unknown): ProviderOutputObservation {
  const record = isRecord(value) ? value : null;
  const thread = maybeString(record?.thread_id) ?? (isRecord(record?.thread) ? maybeString(record.thread.id) : null) ?? null;
  const type = maybeString(record?.type);
  const item = isRecord(record?.item) ? record.item : null;
  let displayLines = uniqueLines(collectText(item ?? record));

  if (displayLines.length === 0 && type === 'turn.failed') {
    displayLines = ['Turn failed'];
  }

  return {
    displayLines,
    isStructured: true,
    sessionId: null,
    threadId: thread
  };
}

function observeOpencode(value: unknown): ProviderOutputObservation {
  const record = isRecord(value) ? value : null;
  const sessionId = maybeString(record?.sessionID) ?? null;
  const type = maybeString(record?.type);
  const part = isRecord(record?.part) ? record.part : null;

  let displayLines: string[] = [];
  if (type === 'tool_use') {
    const name = part ? toolName(part) : toolName(record ?? {});
    displayLines = name ? [`Tool: ${name}`] : [];
  } else {
    displayLines = uniqueLines(collectText(part ?? record));
  }

  return {
    displayLines,
    isStructured: true,
    sessionId,
    threadId: null
  };
}

function observeGeneric(value: unknown): ProviderOutputObservation {
  const record = isRecord(value) ? value : null;
  return {
    displayLines: uniqueLines(collectText(record ?? value)),
    isStructured: true,
    sessionId: maybeString(record?.session_id) ?? maybeString(record?.sessionID) ?? null,
    threadId: maybeString(record?.thread_id) ?? null
  };
}

export function observeProviderOutputLine(provider: ProviderName, line: string): ProviderOutputObservation {
  const sanitized = stripVTControlCharacters(line).trim();
  if (!sanitized) {
    return {
      displayLines: [],
      isStructured: false,
      sessionId: null,
      threadId: null
    };
  }

  const parsed = parseJsonLine(sanitized);
  if (parsed === null) {
    return {
      displayLines: [sanitized],
      isStructured: false,
      sessionId: null,
      threadId: null
    };
  }

  switch (provider) {
    case 'amp':
    case 'claude':
    case 'qwen':
      return observeAnthropicLike(parsed);
    case 'gemini':
      return observeGeminiLike(parsed);
    case 'codex':
      return observeCodex(parsed);
    case 'opencode':
      return observeOpencode(parsed);
    default:
      return observeGeneric(parsed);
  }
}
