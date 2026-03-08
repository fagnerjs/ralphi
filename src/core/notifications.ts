import path from 'node:path';

import type {
  NotificationChannel,
  NotificationChannelConfig,
  NotificationEventPreferences,
  ProviderName,
  RalphContextSnapshot,
  RalphRunSummary,
  RalphiNotificationSettings,
  ScheduleMode
} from './types.js';

export type NotificationLifecycleEvent = keyof NotificationEventPreferences;

export interface NotificationChannelOption {
  value: NotificationChannel;
  label: string;
  description: string;
}

export interface ProjectNotificationRequest {
  event: NotificationLifecycleEvent;
  rootDir: string;
  provider: ProviderName;
  schedule: ScheduleMode;
  contexts: RalphContextSnapshot[];
  summary?: RalphRunSummary | null;
  errorMessage?: string | null;
}

export interface NotificationDispatchResult {
  attempted: NotificationChannel[];
  delivered: NotificationChannel[];
  failures: Array<{ channel: NotificationChannel; message: string }>;
}

interface NotificationMessage {
  title: string;
  text: string;
  payload: Record<string, unknown>;
}

export const notificationEventOptions: Array<{ value: NotificationLifecycleEvent; label: string; description: string }> = [
  {
    value: 'start',
    label: 'Process start',
    description: 'Send a notification after Ralphi finishes preparing the execution and before provider work begins.'
  },
  {
    value: 'success',
    label: 'Process success',
    description: 'Send a notification after the execution completes successfully.'
  },
  {
    value: 'failure',
    label: 'Process failure',
    description: 'Send a notification when the execution stops early or errors out.'
  }
];

export const notificationChannelOptions: NotificationChannelOption[] = [
  {
    value: 'slack',
    label: 'Slack',
    description: 'Slack Incoming Webhook with plain text and block formatting.'
  },
  {
    value: 'teams',
    label: 'Microsoft Teams',
    description: 'Teams Workflow webhook with an Adaptive Card message payload.'
  },
  {
    value: 'discord',
    label: 'Discord',
    description: 'Discord webhook with content text and safe mention handling.'
  },
  {
    value: 'google-chat',
    label: 'Google Chat',
    description: 'Google Chat incoming webhook with a text message.'
  },
  {
    value: 'mattermost',
    label: 'Mattermost',
    description: 'Mattermost incoming webhook with a text message.'
  },
  {
    value: 'ntfy',
    label: 'ntfy',
    description: 'ntfy publish endpoint with text body plus title headers.'
  },
  {
    value: 'generic',
    label: 'Generic webhook',
    description: 'Generic JSON POST with the structured Ralphi event payload.'
  }
];

function defaultChannelConfig(): NotificationChannelConfig {
  return {
    enabled: false,
    url: ''
  };
}

export function defaultNotificationEvents(): NotificationEventPreferences {
  return {
    start: true,
    success: true,
    failure: true
  };
}

export function defaultNotificationSettings(): RalphiNotificationSettings {
  return {
    events: defaultNotificationEvents(),
    channels: Object.fromEntries(
      notificationChannelOptions.map(option => [option.value, defaultChannelConfig()])
    ) as Record<NotificationChannel, NotificationChannelConfig>
  };
}

export function notificationChannelLabel(channel: NotificationChannel): string {
  return notificationChannelOptions.find(option => option.value === channel)?.label ?? channel;
}

export function notificationChannelUrlHint(channel: NotificationChannel): string {
  switch (channel) {
    case 'slack':
      return 'Expected URL: hooks.slack.com/services/...';
    case 'teams':
      return 'Expected URL: a Teams Workflow / Power Automate webhook endpoint.';
    case 'discord':
      return 'Expected URL: discord.com/api/webhooks/...';
    case 'google-chat':
      return 'Expected URL: chat.googleapis.com/v1/spaces/.../messages?key=...&token=...';
    case 'mattermost':
      return 'Expected URL: your Mattermost incoming webhook endpoint.';
    case 'ntfy':
      return 'Expected URL: ntfy.sh/<topic> or your self-hosted ntfy topic endpoint.';
    case 'generic':
      return 'Expected URL: any HTTPS endpoint that accepts JSON POST requests.';
  }
}

function normalizeChannelConfig(input?: Partial<NotificationChannelConfig> | null): NotificationChannelConfig {
  return {
    enabled: Boolean(input?.enabled),
    url: String(input?.url ?? '').trim()
  };
}

export function normalizeNotificationSettings(input?: Partial<RalphiNotificationSettings> | null): RalphiNotificationSettings {
  const defaults = defaultNotificationSettings();
  const channels = Object.fromEntries(
    notificationChannelOptions.map(option => [option.value, normalizeChannelConfig(input?.channels?.[option.value])])
  ) as Record<NotificationChannel, NotificationChannelConfig>;

  return {
    events: {
      ...defaults.events,
      ...(input?.events ?? {})
    },
    channels
  };
}

function isChannelConfigured(config?: NotificationChannelConfig | null): config is NotificationChannelConfig {
  return Boolean(config?.url?.trim());
}

function projectLabel(rootDir: string): string {
  const basename = path.basename(rootDir).trim();
  return basename || rootDir;
}

function summarizeContexts(contexts: RalphContextSnapshot[]): { total: number; completed: number; pending: number } {
  const total = contexts.length;
  const completed = contexts.filter(context => context.done).length;
  return {
    total,
    completed,
    pending: Math.max(total - completed, 0)
  };
}

function eventHeading(event: NotificationLifecycleEvent, project: string): string {
  switch (event) {
    case 'start':
      return `Ralphi started · ${project}`;
    case 'success':
      return `Ralphi finished · ${project}`;
    case 'failure':
      return `Ralphi attention needed · ${project}`;
  }
}

function buildNotificationMessage(request: ProjectNotificationRequest): NotificationMessage {
  const project = projectLabel(request.rootDir);
  const counts = summarizeContexts(request.contexts);
  const title = eventHeading(request.event, project);
  const lines = [
    title,
    `Provider: ${request.provider}`,
    `Schedule: ${request.schedule}`,
    request.event === 'start'
      ? `Prepared ${counts.total} PRD workstream${counts.total === 1 ? '' : 's'}.`
      : `Progress: ${counts.completed}/${counts.total} PRD${counts.total === 1 ? '' : 's'} complete.`
  ];

  if (request.summary?.finalBranchName) {
    lines.push(`Final branch: ${request.summary.finalBranchName}`);
  }

  if (request.errorMessage?.trim()) {
    lines.push(`Reason: ${request.errorMessage.trim()}`);
  }

  const payload = {
    event: request.event,
    project,
    rootDir: request.rootDir,
    provider: request.provider,
    schedule: request.schedule,
    totalContexts: counts.total,
    completedContexts: counts.completed,
    pendingContexts: counts.pending,
    finalBranchName: request.summary?.finalBranchName ?? null,
    errorMessage: request.errorMessage ?? null,
    contexts: request.contexts.map(context => ({
      title: context.title,
      sourcePrd: context.sourcePrd,
      status: context.status,
      done: context.done,
      branchName: context.branchName ?? null,
      worktreePath: context.worktreePath ?? null,
      lastError: context.lastError ?? null
    }))
  } satisfies Record<string, unknown>;

  return {
    title,
    text: lines.join('\n'),
    payload
  };
}

function truncateForEmbed(value: string, maxLength = 1900): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function notificationPriority(event: NotificationLifecycleEvent): 'default' | 'high' {
  return event === 'failure' ? 'high' : 'default';
}

async function ensureWebhookResponse(response: Response, channel: NotificationChannel): Promise<void> {
  if (response.ok) {
    return;
  }

  const detail = (await response.text().catch(() => '')).trim();
  throw new Error(detail || `${notificationChannelLabel(channel)} returned HTTP ${response.status}.`);
}

async function postJson(url: string, body: unknown, channel: NotificationChannel, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });

  await ensureWebhookResponse(response, channel);
}

async function postText(url: string, body: string, channel: NotificationChannel, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...headers
    },
    body
  });

  await ensureWebhookResponse(response, channel);
}

function buildSlackPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    text: message.text,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: message.title,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message.text
        }
      }
    ]
  };
}

function buildTeamsPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    summary: message.title,
    text: message.title,
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: message.title,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true
            },
            {
              type: 'TextBlock',
              text: message.text,
              wrap: true
            }
          ]
        }
      }
    ]
  };
}

function buildDiscordPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    content: truncateForEmbed(message.text),
    allowed_mentions: {
      parse: []
    }
  };
}

function buildGoogleChatPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    text: message.text
  };
}

function buildMattermostPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    text: message.text
  };
}

function buildGenericPayload(message: NotificationMessage): Record<string, unknown> {
  return {
    title: message.title,
    text: message.text,
    ...message.payload
  };
}

async function dispatchChannel(
  channel: NotificationChannel,
  config: NotificationChannelConfig,
  message: NotificationMessage,
  event: NotificationLifecycleEvent
): Promise<void> {
  switch (channel) {
    case 'slack':
      await postJson(config.url, buildSlackPayload(message), channel);
      return;
    case 'teams':
      await postJson(config.url, buildTeamsPayload(message), channel);
      return;
    case 'discord':
      await postJson(config.url, buildDiscordPayload(message), channel);
      return;
    case 'google-chat':
      await postJson(config.url, buildGoogleChatPayload(message), channel);
      return;
    case 'mattermost':
      await postJson(config.url, buildMattermostPayload(message), channel);
      return;
    case 'ntfy':
      await postText(config.url, message.text, channel, {
        Title: message.title,
        Priority: notificationPriority(event)
      });
      return;
    case 'generic':
      await postJson(config.url, buildGenericPayload(message), channel);
  }
}

export async function dispatchProjectNotification(
  settingsInput: RalphiNotificationSettings | null | undefined,
  request: ProjectNotificationRequest
): Promise<NotificationDispatchResult> {
  const settings = normalizeNotificationSettings(settingsInput);
  const attempted: NotificationChannel[] = [];
  const delivered: NotificationChannel[] = [];
  const failures: Array<{ channel: NotificationChannel; message: string }> = [];

  if (!settings.events[request.event]) {
    return {
      attempted,
      delivered,
      failures
    };
  }

  const message = buildNotificationMessage(request);

  for (const option of notificationChannelOptions) {
    const channel = option.value;
    const config = settings.channels[channel];
    if (!config?.enabled || !isChannelConfigured(config)) {
      continue;
    }

    attempted.push(channel);
    try {
      await dispatchChannel(channel, config, message, request.event);
      delivered.push(channel);
    } catch (error) {
      failures.push({
        channel,
        message: error instanceof Error ? error.message : `Unable to reach ${notificationChannelLabel(channel)}.`
      });
    }
  }

  return {
    attempted,
    delivered,
    failures
  };
}
