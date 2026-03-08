import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateUsageTotals,
  buildCompactUsageSummary,
  buildUsageDisplayRows,
  extractUsageTotalsFromOutput,
  formatUsageCost,
  mergeUsageTotals
} from './usage.js';
import { makeUsageTotals } from '../test-support.js';

test('extractUsageTotalsFromOutput merges the richest JSON usage with supplemental text fields', () => {
  const output = `
noise
{"token_usage":{"input_tokens":1200,"output_tokens":300,"total_tokens":1500}}
Token usage :: cost_usd=0.42 USD
`;

  const usage = extractUsageTotalsFromOutput(output);

  assert.deepEqual(usage, {
    inputTokens: 1200,
    cachedInputTokens: null,
    outputTokens: 300,
    reasoningOutputTokens: null,
    totalTokens: 1500,
    totalCostUsd: 0.42,
    currency: 'USD'
  });
});

test('extractUsageTotalsFromOutput parses text-only usage summaries without separators', () => {
  const output = 'Usage summary · input tokens 1,200 · cached input tokens 300 · output tokens 450 · total tokens 1,950 · spend $0.12';

  const usage = extractUsageTotalsFromOutput(output);

  assert.deepEqual(usage, {
    inputTokens: 1200,
    cachedInputTokens: 300,
    outputTokens: 450,
    reasoningOutputTokens: null,
    totalTokens: 1950,
    totalCostUsd: 0.12,
    currency: 'USD'
  });
});

test('mergeUsageTotals and aggregateUsageTotals sum optional token counters safely', () => {
  const first = makeUsageTotals({
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    totalCostUsd: 0.1
  });
  const second = makeUsageTotals({
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
    totalCostUsd: 0.05
  });

  const merged = mergeUsageTotals(first, second);
  const aggregated = aggregateUsageTotals([first, null, second]);

  assert.equal(merged?.inputTokens, 180);
  assert.equal(merged?.outputTokens, 70);
  assert.equal(merged?.totalTokens, 250);
  assert.equal(merged?.totalCostUsd, 0.15000000000000002);
  assert.deepEqual(aggregated, merged);
});

test('buildUsageDisplayRows and buildCompactUsageSummary format tokens and spend for summaries', () => {
  const usage = makeUsageTotals({
    inputTokens: 3400,
    cachedInputTokens: 120,
    outputTokens: 560,
    totalTokens: 4080,
    totalCostUsd: 1.2345
  });

  const rows = buildUsageDisplayRows(usage);
  const summary = buildCompactUsageSummary(usage);

  assert.deepEqual(rows.map(row => row.label), ['Tokens', 'Input', 'Cached', 'Output', 'Spend']);
  assert.match(rows.find(row => row.label === 'Tokens')?.value ?? '', /4,080/);
  assert.match(rows.find(row => row.label === 'Spend')?.value ?? '', /\$1\.2345/);
  assert.match(summary ?? '', /4,080 tokens/);
  assert.match(summary ?? '', /\$1\.2345/);
  assert.equal(formatUsageCost(0.5, 'mixed'), '0.5000 mixed');
});
