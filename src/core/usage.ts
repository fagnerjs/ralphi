import { stripVTControlCharacters } from 'node:util';

import type { RalphUsageTotals } from './types.js';

const usageKeyVariants = {
  inputTokens: new Set(['inputtokens', 'prompttokens']),
  cachedInputTokens: new Set(['cachedinputtokens']),
  outputTokens: new Set(['outputtokens', 'completiontokens']),
  reasoningOutputTokens: new Set(['reasoningoutputtokens', 'reasoningtokens']),
  totalTokens: new Set(['totaltokens']),
  totalCostUsd: new Set(['totalcostusd', 'costusd', 'totalcost', 'cost', 'spendusd', 'spend']),
  currency: new Set(['currency', 'currencycode'])
} as const;

const relevantTextPattern =
  /\b(token usage|tokens?|total_tokens|input_tokens|output_tokens|prompt_tokens|completion_tokens|cost(?:_usd)?|spend|usage)\b/i;

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

function normalizeUsageCandidate(source: Record<string, unknown>): RalphUsageTotals | null {
  const usage = createEmptyUsageTotals();

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = sanitizeKey(rawKey);

    if (usageKeyVariants.inputTokens.has(key)) {
      usage.inputTokens = parseNumber(rawValue);
      continue;
    }

    if (usageKeyVariants.cachedInputTokens.has(key)) {
      usage.cachedInputTokens = parseNumber(rawValue);
      continue;
    }

    if (usageKeyVariants.outputTokens.has(key)) {
      usage.outputTokens = parseNumber(rawValue);
      continue;
    }

    if (usageKeyVariants.reasoningOutputTokens.has(key)) {
      usage.reasoningOutputTokens = parseNumber(rawValue);
      continue;
    }

    if (usageKeyVariants.totalTokens.has(key)) {
      usage.totalTokens = parseNumber(rawValue);
      continue;
    }

    if (usageKeyVariants.totalCostUsd.has(key)) {
      usage.totalCostUsd = parseNumber(rawValue);
      if (usage.totalCostUsd !== null && !usage.currency) {
        usage.currency = 'USD';
      }
      continue;
    }

    if (usageKeyVariants.currency.has(key)) {
      usage.currency = parseCurrency(rawValue);
    }
  }

  return hasUsageTotals(usage) ? usage : null;
}

function candidateWeight(usage: RalphUsageTotals, sourceKey?: string, lineIndex = 0): number {
  const normalizedSourceKey = sourceKey ? sanitizeKey(sourceKey) : '';
  let score = lineIndex;

  if (normalizedSourceKey === 'totaltokenusage' || normalizedSourceKey === 'totalusage') {
    score += 80;
  } else if (normalizedSourceKey === 'tokenusage' || normalizedSourceKey === 'usage') {
    score += 50;
  } else if (normalizedSourceKey === 'lasttokenusage') {
    score += 30;
  }

  if (usage.totalTokens !== null) score += 100;
  if (usage.totalCostUsd !== null) score += 40;
  if (usage.inputTokens !== null) score += 10;
  if (usage.outputTokens !== null) score += 10;
  if (usage.cachedInputTokens !== null) score += 5;
  if (usage.reasoningOutputTokens !== null) score += 5;

  return score;
}

function collectJsonCandidates(
  value: unknown,
  candidates: Array<{ usage: RalphUsageTotals; score: number; index: number }>,
  keyHint?: string,
  lineIndex = 0
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonCandidates(item, candidates, keyHint, lineIndex);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const usage = normalizeUsageCandidate(record);
  if (usage) {
    candidates.push({
      usage,
      score: candidateWeight(usage, keyHint, lineIndex),
      index: lineIndex
    });
  }

  for (const [key, nested] of Object.entries(record)) {
    collectJsonCandidates(nested, candidates, key, lineIndex);
  }
}

function extractJsonUsage(output: string): RalphUsageTotals | null {
  const candidates: Array<{ usage: RalphUsageTotals; score: number; index: number }> = [];
  const lines = output.split(/\r?\n/);

  lines.forEach((line, index) => {
    const sanitized = stripVTControlCharacters(line).trim();
    if (!sanitized.startsWith('{') && !sanitized.startsWith('[')) {
      return;
    }

    try {
      const parsed = JSON.parse(sanitized) as unknown;
      collectJsonCandidates(parsed, candidates, undefined, index);
    } catch {
      // Ignore non-JSON output lines.
    }
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => left.score - right.score || left.index - right.index);
  return candidates[candidates.length - 1]?.usage ?? null;
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
    /\btokens?\s+(?:used|consumed)\b\s*[=:]?\s*([\d,.]+)/i
  ]);
  usage.inputTokens = parseTextNumber(sanitized, [
    /\b(?:input|prompt)(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\b(?:input|prompt)(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i
  ]);
  usage.cachedInputTokens = parseTextNumber(sanitized, [
    /\bcached(?:[ _]input)?(?:[ _]tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\bcached(?:[ _]input)?(?:[ _]tokens?)?\b[^0-9]{0,12}([\d,.]+)/i
  ]);
  usage.outputTokens = parseTextNumber(sanitized, [
    /\b(?:output|completion)(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\b(?:output|completion)(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i
  ]);
  usage.reasoningOutputTokens = parseTextNumber(sanitized, [
    /\breasoning(?:_output)?(?:_tokens?| tokens?)?\b\s*[=:]\s*([\d,.]+)/i,
    /\breasoning(?:_output)?(?:_tokens?| tokens?)?\b[^0-9]{0,12}([\d,.]+)/i
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
        score: candidateWeight(usage, undefined, index),
        index
      };
    })
    .filter((candidate): candidate is { usage: RalphUsageTotals; score: number; index: number } => Boolean(candidate));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  return candidates.reduce<RalphUsageTotals | null>((merged, candidate) => fillMissing(merged, candidate.usage), null);
}

function mergeCurrency(left: string | null | undefined, right: string | null | undefined): string | null {
  if (left && right && left !== right) {
    return 'MIXED';
  }

  return left ?? right ?? null;
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

function fillMissing(primary: RalphUsageTotals | null, secondary: RalphUsageTotals | null): RalphUsageTotals | null {
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

export function extractUsageTotalsFromOutput(output: string): RalphUsageTotals | null {
  const jsonUsage = extractJsonUsage(output);
  const textUsage = extractTextUsage(output);

  if (!jsonUsage && !textUsage) {
    return null;
  }

  const preferred = jsonUsage && textUsage
    ? candidateWeight(jsonUsage) >= candidateWeight(textUsage)
      ? jsonUsage
      : textUsage
    : jsonUsage ?? textUsage;
  const fallback = preferred === jsonUsage ? textUsage : jsonUsage;

  return fillMissing(preferred, fallback);
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
  const tokens = formatTokenCount(usage.totalTokens);
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
