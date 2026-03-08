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

test('extractUsageTotalsFromOutput merges assistant deltas with final anthropic-style result totals', () => {
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        usage: {
          input_tokens: 1200,
          cache_creation_input_tokens: 300,
          output_tokens: 400
        }
      }
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-2',
        usage: {
          input_tokens: 800,
          cache_read_input_tokens: 200,
          output_tokens: 100
        }
      }
    }),
    JSON.stringify({
      type: 'result',
      usage: {
        total_tokens: 2500
      },
      cost_usd: 0.42
    })
  ].join('\n');

  const usage = extractUsageTotalsFromOutput(output, 'claude');

  assert.deepEqual(usage, {
    inputTokens: 2000,
    cachedInputTokens: 500,
    outputTokens: 500,
    reasoningOutputTokens: null,
    totalTokens: 2500,
    totalCostUsd: 0.42,
    currency: 'USD'
  });
});

test('extractUsageTotalsFromOutput parses gemini stream-json result stats', () => {
  const output = JSON.stringify({
    type: 'result',
    stats: {
      total_tokens: 1500,
      input_tokens: 1200,
      output_tokens: 300,
      cached: 100,
      input: 1100
    }
  });

  const usage = extractUsageTotalsFromOutput(output, 'gemini');

  assert.deepEqual(usage, {
    inputTokens: 1200,
    cachedInputTokens: 100,
    outputTokens: 300,
    reasoningOutputTokens: null,
    totalTokens: 1500,
    totalCostUsd: null,
    currency: null
  });
});

test('extractUsageTotalsFromOutput prefers codex token_count totals when available', () => {
  const output = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 16800,
            cached_input_tokens: 70656,
            output_tokens: 1206,
            reasoning_output_tokens: 896,
            total_tokens: 18006
          }
        }
      }
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 16800,
        cached_input_tokens: 70656,
        output_tokens: 1206,
        total_tokens: 18006
      }
    })
  ].join('\n');

  const usage = extractUsageTotalsFromOutput(output, 'codex');

  assert.deepEqual(usage, {
    inputTokens: 16800,
    cachedInputTokens: 70656,
    outputTokens: 1206,
    reasoningOutputTokens: 896,
    totalTokens: 18006,
    totalCostUsd: null,
    currency: null
  });
});

test('extractUsageTotalsFromOutput aggregates opencode export session totals across assistant messages', () => {
  const output = JSON.stringify(
    {
      info: {
        id: 'session-1'
      },
      messages: [
        {
          info: {
            metadata: {
              assistant: {
                cost: 0.31,
                tokens: {
                  input: 1000,
                  output: 200,
                  reasoning: 50,
                  total: 1250,
                  cache: {
                    read: 300,
                    write: 20
                  }
                }
              }
            }
          }
        },
        {
          info: {
            metadata: {
              assistant: {
                cost: 0.12,
                tokens: {
                  input: 700,
                  output: 120,
                  reasoning: null,
                  total: 820,
                  cache: {
                    read: 80,
                    write: 0
                  }
                }
              }
            }
          }
        }
      ]
    },
    null,
    2
  );

  const usage = extractUsageTotalsFromOutput(output, 'opencode');

  assert.deepEqual(usage, {
    inputTokens: 1700,
    cachedInputTokens: 400,
    outputTokens: 320,
    reasoningOutputTokens: 50,
    totalTokens: 2070,
    totalCostUsd: 0.43,
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
