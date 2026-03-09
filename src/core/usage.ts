import { stripVTControlCharacters } from 'node:util';

import type { ProviderName, RalphUsageTotals } from './types.js';

type UsageField = keyof RalphUsageTotals;
type UsageValue = RalphUsageTotals[UsageField];

interface UsageCandidate {
  usage: RalphUsageTotals;
  score: number;
  index: number;
}

export interface UsageTracker {
  observeAbsolute: (usage: RalphUsageTotals | null) => RalphUsageTotals | null;
  observeDelta: (usage: RalphUsageTotals | null, key?: string) => RalphUsageTotals | null;
  observeLine: (line: string) => RalphUsageTotals | null;
  getTotals: () => RalphUsageTotals | null;
}

const usageKeyVariants = {
  inputTokens: new Set([
    'inputtokens',
    'prompttokens',
    'prompttokencount',
    'inputtokencount',
    'cachecreationinputtokens',
    'cachereadinputtokens',
    'cachewriteinputtokens'
  ]),
  directInputTokens: new Set(['inputtokens', 'prompttokens', 'prompttokencount', 'inputtokencount']),
  cachedInputTokens: new Set([
    'cachedinputtokens',
    'cachedtokens',
    'cachecreationinputtokens',
    'cachereadinputtokens',
    'cachewriteinputtokens',
    'cachedcontenttokencount'
  ]),
  outputTokens: new Set(['outputtokens', 'completiontokens', 'completiontokencount', 'candidatestokencount']),
  reasoningOutputTokens: new Set([
    'reasoningoutputtokens',
    'reasoningtokens',
    'reasoningtokens',
    'reasoningtokencount',
    'thoughtstokencount'
  ]),
  totalTokens: new Set(['totaltokens', 'totaltokencount']),
  totalCostUsd: new Set(['totalcostusd', 'costusd', 'totalcost', 'cost', 'spendusd', 'spend']),
  currency: new Set(['currency', 'currencycode'])
} as const;

const tokenContextKeys = new Set([
  'usage',
  'tokenusage',
  'totaltokenusage',
  'lasttokenusage',
  'totalusage',
  'usageinfo',
  'tokenusageinfo',
  'tokens',
  'stats',
  'usagemetadata'
]);

const relevantTextPattern =
  /\b(token usage|tokens?|total_tokens|input_tokens|output_tokens|prompt_tokens|completion_tokens|cost(?:_usd)?|spend|usage|reasoning tokens?)\b/i;

function createEmptyUsageTotals(): RalphUsageTotals {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    totalCostUsd: null,
    currency: null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-z]/gi, '').toLowerCase();
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[$,\s]/g, '');
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCurrency(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toUpperCase();
  return trimmed || null;
}

function sumOptional(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left === null || left === undefined) {
    return right ?? null;
  }

  if (right === null || right === undefined) {
    return left;
  }

  return left + right;
}

function maxOptional(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left === null || left === undefined) {
    return right ?? null;
  }

  if (right === null || right === undefined) {
    return left;
  }

  return Math.max(left, right);
}

function mergeCurrency(left: string | null | undefined, right: string | null | undefined): string | null {
  if (left && right && left !== right) {
    return 'MIXED';
  }

  return left ?? right ?? null;
}

function setIfPresent(current: number | null, value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed === null ? current : parsed;
}

function setIfMissing(current: number | null, value: unknown): number | null {
  if (current !== null) {
    return current;
  }

  return parseNumber(value);
}

function addIfPresent(current: number | null, value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed === null ? current : sumOptional(current, parsed);
}

function normalizeUsageCandidate(source: Record<string, unknown>, pathSegments: string[] = []): RalphUsageTotals | null {
  const usage = createEmptyUsageTotals();
  const normalizedPath = pathSegments.map(segment => sanitizeKey(segment)).filter(Boolean);
  const inTokenContext = normalizedPath.some(segment => tokenContextKeys.has(segment));
  const inCacheContext = normalizedPath.includes('cache');

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = sanitizeKey(rawKey);

    if (usageKeyVariants.directInputTokens.has(key)) {
      usage.inputTokens = setIfPresent(usage.inputTokens, rawValue);
      continue;
    }

    if (usageKeyVariants.cachedInputTokens.has(key)) {
      usage.cachedInputTokens = addIfPresent(usage.cachedInputTokens, rawValue);
      continue;
    }

    if (usageKeyVariants.outputTokens.has(key)) {
      usage.outputTokens = setIfPresent(usage.outputTokens, rawValue);
      continue;
    }

    if (usageKeyVariants.reasoningOutputTokens.has(key)) {
      usage.reasoningOutputTokens = setIfPresent(usage.reasoningOutputTokens, rawValue);
      continue;
    }

    if (usageKeyVariants.totalTokens.has(key)) {
      usage.totalTokens = setIfPresent(usage.totalTokens, rawValue);
      continue;
    }

    if (usageKeyVariants.totalCostUsd.has(key)) {
      usage.totalCostUsd = setIfPresent(usage.totalCostUsd, rawValue);
      if (usage.totalCostUsd !== null && !usage.currency) {
        usage.currency = 'USD';
      }
      continue;
    }

    if (usageKeyVariants.currency.has(key)) {
      usage.currency = parseCurrency(rawValue) ?? usage.currency;
      continue;
    }

    if (inTokenContext && (key === 'input' || key === 'prompt')) {
      usage.inputTokens = setIfMissing(usage.inputTokens, rawValue);
      continue;
    }

    if (inTokenContext && (key === 'output' || key === 'completion')) {
      usage.outputTokens = setIfMissing(usage.outputTokens, rawValue);
      continue;
    }

    if (inTokenContext && key === 'total') {
      usage.totalTokens = setIfMissing(usage.totalTokens, rawValue);
      continue;
    }

    if (inTokenContext && key === 'cached') {
      usage.cachedInputTokens = addIfPresent(usage.cachedInputTokens, rawValue);
      continue;
    }

    if (inTokenContext && (key === 'reasoning' || key === 'thoughts')) {
      usage.reasoningOutputTokens = setIfMissing(usage.reasoningOutputTokens, rawValue);
      continue;
    }

    if (inCacheContext && (key === 'read' || key === 'write')) {
      usage.cachedInputTokens = addIfPresent(usage.cachedInputTokens, rawValue);
    }
  }

  return hasUsageTotals(usage) ? usage : null;
}

function usageFieldCount(usage: RalphUsageTotals | null | undefined): number {
  if (!usage) {
    return 0;
  }

  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
    usage.totalCostUsd
  ].filter(value => typeof value === 'number' && Number.isFinite(value)).length;
}

function usageRichnessScore(usage: RalphUsageTotals): number {
  let score = usageFieldCount(usage) * 10;

  if (usage.totalTokens !== null) score += 100;
  if (resolveUsageTotalTokens(usage) !== null) score += 20;
  if (usage.totalCostUsd !== null) score += 40;
  if (usage.inputTokens !== null) score += 10;
  if (usage.outputTokens !== null) score += 10;
  if (usage.cachedInputTokens !== null) score += 5;
  if (usage.reasoningOutputTokens !== null) score += 5;

  return score;
}

function candidateWeight(usage: RalphUsageTotals, pathSegments: string[] = [], lineIndex = 0): number {
  const normalizedPath = pathSegments.map(segment => sanitizeKey(segment)).filter(Boolean).join('.');
  let score = lineIndex + usageRichnessScore(usage);

  if (normalizedPath.includes('totaltokenusage')) {
    score += 80;
  } else if (normalizedPath.includes('lasttokenusage')) {
    score += 50;
  } else if (normalizedPath.includes('tokenusage') || normalizedPath.endsWith('usage')) {
    score += 30;
  }

  if (normalizedPath.includes('stats') || normalizedPath.includes('usagemetadata')) {
    score += 20;
  }

  if (normalizedPath.includes('tokens')) {
    score += 10;
  }

  return score;
}

function collectJsonCandidates(value: unknown, candidates: UsageCandidate[], pathSegments: string[] = [], lineIndex = 0): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonCandidates(item, candidates, [...pathSegments, String(index)], lineIndex));
    return;
  }

  const record = value as Record<string, unknown>;
  const usage = normalizeUsageCandidate(record, pathSegments);
  if (usage) {
    candidates.push({
      usage,
      score: candidateWeight(usage, pathSegments, lineIndex),
      index: lineIndex
    });
  }

  for (const [key, nested] of Object.entries(record)) {
    collectJsonCandidates(nested, candidates, [...pathSegments, key], lineIndex);
  }
}

function extractUsageTotalsFromJsonValue(value: unknown): RalphUsageTotals | null {
  const candidates: UsageCandidate[] = [];
  collectJsonCandidates(value, candidates, [], 0);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  return candidates.reduce<RalphUsageTotals | null>((merged, candidate) => fillUsageTotals(merged, candidate.usage), null);
}

function parseTextNumber(line: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    const value = parseNumber(match?.[1] ?? null);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function extractTextUsageLine(line: string): RalphUsageTotals | null {
  const sanitized = stripVTControlCharacters(line).trim();
  if (!relevantTextPattern.test(sanitized)) {
    return null;
  }

  const usage = createEmptyUsageTotals();
  usage.totalTokens = parseTextNumber(sanitized, [
    /\btotal(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\btotal(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i,
    /\btokens?\s+(?:used|consumed)\b\s*[=:]?\s*([\d,.]+)/i,
    /\btoken usage\b[^0-9]{0,12}(?:total\s*[=:]\s*)?([\d,.]+)/i
  ]);
  usage.inputTokens = parseTextNumber(sanitized, [
    /\b(?:input|prompt)(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\b(?:input|prompt)(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i,
    /\binput\b\s*([\d,.]+)\b/i
  ]);
  usage.cachedInputTokens = parseTextNumber(sanitized, [
    /\bcached(?:[ _]input)?(?:[ _]tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\bcached(?:[ _]input)?(?:[ _]tokens?)?\b[^0-9]{0,12}([\d,.]+)/i,
    /\(\+\s*([\d,.]+)\s+cached\)/i,
    /\bcache(?: creation| read| write)?(?: input)? tokens?\b[^0-9]{0,12}([\d,.]+)/i
  ]);
  usage.outputTokens = parseTextNumber(sanitized, [
    /\b(?:output|completion)(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\b(?:output|completion)(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i,
    /\boutput\b\s*([\d,.]+)\b/i
  ]);
  usage.reasoningOutputTokens = parseTextNumber(sanitized, [
    /\breasoning(?:_output)?(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\breasoning(?:_output)?(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i,
    /\(\s*reasoning\s*([\d,.]+)\s*\)/i
  ]);
  usage.totalCostUsd = parseTextNumber(sanitized, [
    /\b(?:total[_ ]cost(?:_usd)?|cost(?:_usd)?|spend(?:_usd)?)\b\s*[=:]\s*\$?\s*([\d,.]+)/i,
    /\b(?:total[_ ]cost(?:_usd)?|cost(?:_usd)?|spend(?:_usd)?)\b[^0-9$]{0,12}\$?\s*([\d,.]+)/i
  ]);

  if (usage.totalCostUsd !== null && /(?:\bUSD\b|\$)/i.test(sanitized)) {
    usage.currency = 'USD';
  }

  return hasUsageTotals(usage) ? usage : null;
}

function extractTextUsage(output: string): RalphUsageTotals | null {
  const candidates = output
    .split(/\r?\n/)
    .map((line, index) => {
      const usage = extractTextUsageLine(line);
      if (!usage) {
        return null;
      }

      return {
        usage,
        score: candidateWeight(usage, [], index),
        index
      };
    })
    .filter((candidate): candidate is UsageCandidate => Boolean(candidate));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  return candidates.reduce<RalphUsageTotals | null>((merged, candidate) => fillUsageTotals(merged, candidate.usage), null);
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

function parseWholeJson(output: string): unknown | null {
  const sanitized = stripVTControlCharacters(output).trim();
  if (!sanitized.startsWith('{') && !sanitized.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(sanitized) as unknown;
  } catch {
    return null;
  }
}

function deriveUsageObservationKey(record: Record<string, unknown>, fallback: string): string {
  const keys = [record.id, record.uuid, record.message_id, record.session_id, record.thread_id].map(value =>
    typeof value === 'string' ? value : null
  );
  return keys.find(Boolean) ?? fallback;
}

function observeGenericRecord(tracker: InternalUsageTracker, record: Record<string, unknown>, lineKey: string): void {
  const type = typeof record.type === 'string' ? record.type : null;
  const role = typeof record.role === 'string' ? record.role : null;
  const message = isRecord(record.message) ? record.message : null;
  const messageRole = typeof message?.role === 'string' ? message.role : null;
  const key = deriveUsageObservationKey(message ?? record, lineKey);
  const messageUsage = message ? extractUsageTotalsFromJsonValue(message) : null;
  const recordUsage = extractUsageTotalsFromJsonValue(record);

  if (type === 'assistant' || role === 'assistant' || messageRole === 'assistant') {
    tracker.observeDelta(messageUsage ?? recordUsage, `assistant:${key}`);
    return;
  }

  if (type === 'result' || type === 'summary' || type === 'response') {
    tracker.observeAbsolute(recordUsage);
    return;
  }

  if (recordUsage) {
    tracker.observeAbsolute(recordUsage);
  }
}

function observeAnthropicLikeRecord(tracker: InternalUsageTracker, record: Record<string, unknown>, lineKey: string): void {
  const type = typeof record.type === 'string' ? record.type : null;
  const message = isRecord(record.message) ? record.message : null;
  const messageKey = deriveUsageObservationKey(message ?? record, lineKey);

  if (type === 'assistant') {
    tracker.observeDelta(extractUsageTotalsFromJsonValue(message ?? record), `assistant:${messageKey}`);
    return;
  }

  if (type === 'result') {
    tracker.observeAbsolute(extractUsageTotalsFromJsonValue(record));
    return;
  }

  observeGenericRecord(tracker, record, lineKey);
}

function observeGeminiRecord(tracker: InternalUsageTracker, record: Record<string, unknown>, lineKey: string): void {
  const type = typeof record.type === 'string' ? record.type : null;

  if (type === 'result') {
    tracker.observeAbsolute(extractUsageTotalsFromJsonValue(record));
    return;
  }

  observeGenericRecord(tracker, record, lineKey);
}

function observeCodexRecord(tracker: InternalUsageTracker, record: Record<string, unknown>, lineKey: string): void {
  const type = typeof record.type === 'string' ? record.type : null;
  const payload = isRecord(record.payload) ? record.payload : null;
  const payloadType = typeof payload?.type === 'string' ? payload.type : null;

  if (type === 'turn.completed') {
    const usage = extractUsageTotalsFromJsonValue(isRecord(record.usage) ? record.usage : record);
    tracker.observeDelta(usage, `turn.completed:${deriveUsageObservationKey(record, lineKey)}`);
    return;
  }

  if ((type === 'event_msg' && payloadType === 'token_count') || type === 'token_count') {
    const info = payload && isRecord(payload.info) ? payload.info : isRecord(record.info) ? record.info : record;
    tracker.observeAbsolute(extractUsageTotalsFromJsonValue(info));
    return;
  }

  observeGenericRecord(tracker, record, lineKey);
}

function extractOpencodeUsageFromExportValue(value: unknown): RalphUsageTotals | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return null;
  }

  const usages = value.messages
    .map(message => {
      if (!isRecord(message)) {
        return null;
      }

      const info = isRecord(message.info) ? message.info : null;
      const metadata = isRecord(info?.metadata) ? info.metadata : null;
      const assistant = isRecord(metadata?.assistant) ? metadata.assistant : null;
      const tokens = isRecord(assistant?.tokens) ? assistant.tokens : null;
      const cache = isRecord(tokens?.cache) ? tokens.cache : null;
      const cost = parseNumber(assistant?.cost);

      if (!assistant || !tokens) {
        return null;
      }

      const usage: RalphUsageTotals = {
        inputTokens: parseNumber(tokens.input),
        cachedInputTokens: sumOptional(parseNumber(cache?.read), parseNumber(cache?.write)),
        outputTokens: parseNumber(tokens.output),
        reasoningOutputTokens: parseNumber(tokens.reasoning),
        totalTokens: parseNumber(tokens.total),
        totalCostUsd: cost,
        currency: cost !== null ? 'USD' : null
      };

      return hasUsageTotals(usage) ? usage : null;
    })
    .filter((usage): usage is RalphUsageTotals => Boolean(usage));

  return usages.length > 0 ? aggregateUsageTotals(usages) : null;
}

function observeOpencodeRecord(tracker: InternalUsageTracker, record: Record<string, unknown>, lineKey: string): void {
  const exportUsage = extractOpencodeUsageFromExportValue(record);
  if (exportUsage) {
    tracker.observeAbsolute(exportUsage);
    return;
  }

  observeGenericRecord(tracker, record, lineKey);
}

class InternalUsageTracker implements UsageTracker {
  private deltaTotals: RalphUsageTotals | null = null;
  private absoluteTotals: RalphUsageTotals | null = null;
  private readonly seenDeltaKeys = new Set<string>();

  constructor(private readonly provider?: ProviderName) {}

  observeAbsolute(usage: RalphUsageTotals | null): RalphUsageTotals | null {
    if (!hasUsageTotals(usage)) {
      return this.getTotals();
    }

    this.absoluteTotals = mergeMaxUsageTotals(this.absoluteTotals, usage);
    return this.getTotals();
  }

  observeDelta(usage: RalphUsageTotals | null, key?: string): RalphUsageTotals | null {
    if (!hasUsageTotals(usage)) {
      return this.getTotals();
    }

    if (key) {
      if (this.seenDeltaKeys.has(key)) {
        return this.getTotals();
      }
      this.seenDeltaKeys.add(key);
    }

    this.deltaTotals = mergeUsageTotals(this.deltaTotals, usage);
    return this.getTotals();
  }

  observeLine(line: string): RalphUsageTotals | null {
    const sanitized = stripVTControlCharacters(line).trim();
    if (!sanitized) {
      return this.getTotals();
    }

    const parsed = parseJsonLine(sanitized);
    if (parsed !== null) {
      this.observeJsonValue(parsed, sanitized);
    }

    const textUsage = extractTextUsageLine(sanitized);
    if (textUsage) {
      this.observeAbsolute(textUsage);
    }

    return this.getTotals();
  }

  getTotals(): RalphUsageTotals | null {
    const left = this.absoluteTotals;
    const right = this.deltaTotals;

    if (!left) {
      return right;
    }

    if (!right) {
      return left;
    }

    const preferred = compareUsagePreference(left, right) >= 0 ? left : right;
    const fallback = preferred === left ? right : left;
    return fillUsageTotals(preferred, fallback);
  }

  private observeJsonValue(value: unknown, lineKey: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.observeJsonValue(item, `${lineKey}:${index}`));
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    switch (this.provider) {
      case 'amp':
      case 'claude':
      case 'qwen':
        observeAnthropicLikeRecord(this, value, lineKey);
        return;
      case 'gemini':
        observeGeminiRecord(this, value, lineKey);
        return;
      case 'codex':
        observeCodexRecord(this, value, lineKey);
        return;
      case 'opencode':
        observeOpencodeRecord(this, value, lineKey);
        return;
      default:
        observeGenericRecord(this, value, lineKey);
    }
  }
}

function compareUsagePreference(left: RalphUsageTotals, right: RalphUsageTotals): number {
  const leftTokens = resolveUsageTotalTokens(left) ?? -1;
  const rightTokens = resolveUsageTotalTokens(right) ?? -1;

  if (leftTokens !== rightTokens) {
    return leftTokens - rightTokens;
  }

  const leftScore = usageRichnessScore(left);
  const rightScore = usageRichnessScore(right);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  return (left.totalCostUsd ?? -1) - (right.totalCostUsd ?? -1);
}

function mergeMaxUsageTotals(left: RalphUsageTotals | null, right: RalphUsageTotals | null): RalphUsageTotals | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    inputTokens: maxOptional(left.inputTokens, right.inputTokens),
    cachedInputTokens: maxOptional(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: maxOptional(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: maxOptional(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: maxOptional(left.totalTokens, right.totalTokens),
    totalCostUsd: maxOptional(left.totalCostUsd, right.totalCostUsd),
    currency: mergeCurrency(left.currency, right.currency)
  };
}

export function createUsageTracker(provider?: ProviderName): UsageTracker {
  return new InternalUsageTracker(provider);
}

export function hasUsageTotals(usage: RalphUsageTotals | null | undefined): usage is RalphUsageTotals {
  if (!usage) {
    return false;
  }

  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
    usage.totalCostUsd
  ].some(value => typeof value === 'number' && Number.isFinite(value));
}

export function usageTotalsEqual(left: RalphUsageTotals | null | undefined, right: RalphUsageTotals | null | undefined): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  const fields: UsageField[] = [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
    'totalTokens',
    'totalCostUsd',
    'currency'
  ];

  return fields.every(field => left[field] === right[field]);
}

export function fillUsageTotals(primary: RalphUsageTotals | null, secondary: RalphUsageTotals | null): RalphUsageTotals | null {
  if (!primary) {
    return secondary;
  }

  if (!secondary) {
    return primary;
  }

  return {
    inputTokens: primary.inputTokens ?? secondary.inputTokens,
    cachedInputTokens: primary.cachedInputTokens ?? secondary.cachedInputTokens,
    outputTokens: primary.outputTokens ?? secondary.outputTokens,
    reasoningOutputTokens: primary.reasoningOutputTokens ?? secondary.reasoningOutputTokens,
    totalTokens: primary.totalTokens ?? secondary.totalTokens,
    totalCostUsd: primary.totalCostUsd ?? secondary.totalCostUsd,
    currency: mergeCurrency(primary.currency, secondary.currency)
  };
}

export function mergeUsageTotals(left: RalphUsageTotals | null, right: RalphUsageTotals | null): RalphUsageTotals | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    inputTokens: sumOptional(left.inputTokens, right.inputTokens),
    cachedInputTokens: sumOptional(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: sumOptional(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: sumOptional(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: sumOptional(left.totalTokens, right.totalTokens),
    totalCostUsd: sumOptional(left.totalCostUsd, right.totalCostUsd),
    currency: mergeCurrency(left.currency, right.currency)
  };
}

export function aggregateUsageTotals(usages: Array<RalphUsageTotals | null | undefined>): RalphUsageTotals | null {
  return usages.reduce<RalphUsageTotals | null>((total, usage) => mergeUsageTotals(total, usage ?? null), null);
}

export function resolveUsageTotalTokens(usage: RalphUsageTotals | null | undefined): number | null {
  if (!usage) {
    return null;
  }

  if (usage.totalTokens !== null && Number.isFinite(usage.totalTokens)) {
    return usage.totalTokens;
  }

  const fields = [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );

  return fields.length > 0 ? fields.reduce((total, value) => total + value, 0) : null;
}

export function extractUsageTotalsFromOutput(output: string, provider?: ProviderName): RalphUsageTotals | null {
  const tracker = createUsageTracker(provider);
  for (const line of output.split(/\r?\n/)) {
    tracker.observeLine(line);
  }

  const trackerUsage = tracker.getTotals();
  const wholeJson = parseWholeJson(output);
  const wholeJsonUsage = provider === 'opencode' ? extractOpencodeUsageFromExportValue(wholeJson) : extractUsageTotalsFromJsonValue(wholeJson);
  const lineJsonUsage = output
    .split(/\r?\n/)
    .map((line, index) => {
      const parsed = parseJsonLine(line);
      if (parsed === null) {
        return null;
      }

      const usage = extractUsageTotalsFromJsonValue(parsed);
      if (!usage) {
        return null;
      }

      return {
        usage,
        score: candidateWeight(usage, [], index),
        index
      };
    })
    .filter((candidate): candidate is UsageCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .reduce<RalphUsageTotals | null>((merged, candidate) => fillUsageTotals(merged, candidate.usage), null);
  const textUsage = extractTextUsage(output);

  return [trackerUsage, wholeJsonUsage, lineJsonUsage, textUsage].reduce<RalphUsageTotals | null>(
    (merged, candidate) => {
      if (!candidate) {
        return merged;
      }

      if (!merged) {
        return candidate;
      }

      const preferred = compareUsagePreference(candidate, merged) > 0 ? candidate : merged;
      const fallback = preferred === candidate ? merged : candidate;
      return fillUsageTotals(preferred, fallback);
    },
    null
  );
}

export function formatTokenCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatUsageCost(value: number | null | undefined, currency?: string | null): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const normalizedCurrency = (currency ?? 'USD').trim().toUpperCase();
  if (!normalizedCurrency || normalizedCurrency === 'MIXED') {
    return `${value.toFixed(4)} mixed`;
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(value);
  } catch {
    return `${value.toFixed(4)} ${normalizedCurrency}`;
  }
}

export function formatUsageTokenTotal(usage: RalphUsageTotals | null | undefined): string | null {
  return formatTokenCount(resolveUsageTotalTokens(usage));
}

export function buildTokensUsedLabel(usage: RalphUsageTotals | null | undefined): string | null {
  const total = formatUsageTokenTotal(usage);
  return total ? `${total} tokens used` : null;
}

export function buildCostUsedLabel(usage: RalphUsageTotals | null | undefined): string | null {
  const totalCost = formatUsageCost(usage?.totalCostUsd, usage?.currency);
  return totalCost ? `${totalCost} spent` : null;
}

export function buildUsageDisplayRows(usage: RalphUsageTotals | null | undefined): Array<{ label: string; value: string }> {
  if (!hasUsageTotals(usage)) {
    return [];
  }

  const rows: Array<{ label: string; value: string }> = [];
  const totalTokens = formatTokenCount(usage.totalTokens);
  const inputTokens = formatTokenCount(usage.inputTokens);
  const cachedInputTokens = formatTokenCount(usage.cachedInputTokens);
  const outputTokens = formatTokenCount(usage.outputTokens);
  const reasoningOutputTokens = formatTokenCount(usage.reasoningOutputTokens);
  const totalCost = formatUsageCost(usage.totalCostUsd, usage.currency);

  if (totalTokens) rows.push({ label: 'Tokens', value: totalTokens });
  if (inputTokens) rows.push({ label: 'Input', value: inputTokens });
  if (cachedInputTokens) rows.push({ label: 'Cached', value: cachedInputTokens });
  if (outputTokens) rows.push({ label: 'Output', value: outputTokens });
  if (reasoningOutputTokens) rows.push({ label: 'Reasoning', value: reasoningOutputTokens });
  if (totalCost) rows.push({ label: 'Spend', value: totalCost });

  return rows;
}

export function buildCompactUsageSummary(usage: RalphUsageTotals | null | undefined): string | null {
  if (!hasUsageTotals(usage)) {
    return null;
  }

  const parts: string[] = [];
  const tokens = formatUsageTokenTotal(usage);
  const inputTokens = formatTokenCount(usage.inputTokens);
  const outputTokens = formatTokenCount(usage.outputTokens);
  const spend = formatUsageCost(usage.totalCostUsd, usage.currency);

  if (tokens) {
    parts.push(`${tokens} tokens`);
  } else {
    if (inputTokens) {
      parts.push(`in ${inputTokens}`);
    }

    if (outputTokens) {
      parts.push(`out ${outputTokens}`);
    }
  }

  if (spend) {
    parts.push(spend);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
