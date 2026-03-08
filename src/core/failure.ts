import type { RalphFailureCategory, RalphFailureInfo, RalphMcpServerStatus } from './types.js';

function compact(message: string | null | undefined, fallback: string): string {
  const normalized = (message ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return fallback;
  }

  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function isProviderLaunchMessage(lower: string): boolean {
  return (
    lower.includes('not found in path') ||
    lower.includes('spawn ') ||
    lower.includes('enoent') ||
    lower.includes('executable') ||
    lower.includes('permission denied')
  );
}

function isGitMessage(lower: string): boolean {
  return (
    lower.includes('git ') ||
    lower.includes('git:') ||
    lower.includes('worktree') ||
    lower.includes('branch ') ||
    lower.includes('commit ') ||
    lower.includes('rev-parse')
  );
}

function isSkillMessage(lower: string): boolean {
  return lower.includes('skill') || lower.includes('skill.md') || lower.includes('.codex/skills') || lower.includes('.claude/skills');
}

function isInvalidOutputMessage(lower: string): boolean {
  return (
    lower.includes('did not produce') ||
    lower.includes('invalid structured') ||
    lower.includes('invalid json') ||
    lower.includes('valid json') ||
    lower.includes('parse json') ||
    lower.includes('invalid output')
  );
}

function defaultSummary(category: RalphFailureCategory): string {
  switch (category) {
    case 'provider_launch':
      return 'The provider could not be launched.';
    case 'provider_runtime':
      return 'The provider exited with a runtime error.';
    case 'timeout':
      return 'The provider timed out before finishing the iteration.';
    case 'git':
      return 'Git or worktree state blocked the iteration.';
    case 'skill':
      return 'A required skill could not be resolved.';
    case 'invalid_output':
      return 'The provider returned output that Ralphi could not reuse safely.';
    case 'mcp_startup':
      return 'A provider-native MCP server failed during startup.';
    default:
      return 'The iteration failed for an unknown reason.';
  }
}

function recoveryHint(category: RalphFailureCategory, rawLogPath: string | null): string {
  switch (category) {
    case 'provider_launch':
      return 'Install or repair the provider CLI, rerun `ralphi doctor`, then resume.';
    case 'provider_runtime':
      return rawLogPath ? `Inspect ${rawLogPath}, fix the provider error, then retry once or resume.` : 'Inspect the provider log, fix the error, then retry once or resume.';
    case 'timeout':
      return rawLogPath ? `Inspect ${rawLogPath}, reduce scope if needed, then retry once.` : 'Inspect the provider log, reduce scope if needed, then retry once.';
    case 'git':
      return 'Fix the Git/worktree state first. Use `ralphi worktree doctor` if cleanup looks suspicious.';
    case 'skill':
      return 'Fix the missing skill root or project config, rerun `ralphi doctor`, then resume.';
    case 'invalid_output':
      return 'Inspect the prompt and raw log, correct the malformed output path, then restart or regenerate state.';
    case 'mcp_startup':
      return 'Fix the provider-native MCP configuration outside Ralphi, then retry once.';
    default:
      return rawLogPath ? `Inspect ${rawLogPath} and correct the root cause before resuming.` : 'Inspect the raw output and correct the root cause before resuming.';
  }
}

function retryable(category: RalphFailureCategory): boolean {
  return category === 'provider_runtime' || category === 'timeout' || category === 'mcp_startup';
}

export function failureCategoryLabel(category: RalphFailureCategory): string {
  switch (category) {
    case 'provider_launch':
      return 'Provider launch';
    case 'provider_runtime':
      return 'Provider runtime';
    case 'timeout':
      return 'Timeout';
    case 'git':
      return 'Git';
    case 'skill':
      return 'Skill';
    case 'invalid_output':
      return 'Invalid output';
    case 'mcp_startup':
      return 'MCP startup';
    default:
      return 'Unknown';
  }
}

export function classifyFailure(options: {
  message?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  launchError?: boolean;
  rawLogPath?: string | null;
  mcpServers?: RalphMcpServerStatus[];
  retryCount?: number;
}): RalphFailureInfo {
  const message = options.message ?? '';
  const lower = message.toLowerCase();
  const hasMcpFailure = (options.mcpServers ?? []).some(server => server.state === 'failed');

  let category: RalphFailureCategory = 'unknown';

  if (options.timedOut || lower.includes('timed out')) {
    category = 'timeout';
  } else if (hasMcpFailure || (lower.includes('mcp') && (lower.includes('failed') || lower.includes('error')))) {
    category = 'mcp_startup';
  } else if (options.launchError || isProviderLaunchMessage(lower)) {
    category = 'provider_launch';
  } else if (isGitMessage(lower)) {
    category = 'git';
  } else if (isSkillMessage(lower)) {
    category = 'skill';
  } else if (isInvalidOutputMessage(lower)) {
    category = 'invalid_output';
  } else if ((options.exitCode ?? 0) !== 0 || lower.includes('error') || lower.includes('failed')) {
    category = 'provider_runtime';
  }

  return {
    category,
    retryable: retryable(category),
    retryCount: options.retryCount ?? 0,
    summary: compact(message, defaultSummary(category)),
    recoveryHint: recoveryHint(category, options.rawLogPath ?? null),
    rawLogPath: options.rawLogPath ?? null
  };
}

function extractMcpServerName(line: string): string | null {
  const patterns = [
    /\bmcp(?:\s+server)?\s*["'`[]?([a-z0-9._:-]+)["'`\]]?/i,
    /\bserver\s+["'`]?([a-z0-9._:-]+)["'`]?\s+(?:ready|failed|error|connected|started|listening|timed out)/i,
    /\[mcp[:\s-]*([a-z0-9._:-]+)\]/i
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export function parseMcpServerSignal(line: string): RalphMcpServerStatus | null {
  const lower = line.toLowerCase();
  if (!lower.includes('mcp')) {
    return null;
  }

  const ready =
    lower.includes(' ready') ||
    lower.includes(' connected') ||
    lower.includes(' started') ||
    lower.includes(' listening') ||
    lower.includes(' initialized');
  const failed =
    lower.includes(' failed') ||
    lower.includes(' error') ||
    lower.includes(' timed out') ||
    lower.includes(' timeout') ||
    lower.includes(' refused') ||
    lower.includes(' unable') ||
    lower.includes(' denied');

  if (!ready && !failed) {
    return null;
  }

  return {
    name: extractMcpServerName(line) ?? 'provider-native',
    state: failed ? 'failed' : 'ready',
    detail: compact(line, line),
    updatedAt: new Date().toISOString()
  };
}

export function mergeMcpServerSignal(current: RalphMcpServerStatus[], signal: RalphMcpServerStatus): RalphMcpServerStatus[] {
  const next = [...current];
  const index = next.findIndex(entry => entry.name === signal.name);

  if (index === -1) {
    next.push(signal);
    return next.sort((left, right) => left.name.localeCompare(right.name));
  }

  next[index] = signal;
  return next.sort((left, right) => left.name.localeCompare(right.name));
}
