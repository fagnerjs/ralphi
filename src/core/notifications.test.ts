import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultNotificationSettings, dispatchProjectNotification } from './notifications.js';
import { makeContextSnapshot, makeConfig } from '../test-support.js';

test('dispatchProjectNotification uses channel-specific payloads', async () => {
  const config = makeConfig('/tmp/ralphi-notify');
  const context = makeContextSnapshot(config, {
    sourcePrd: '/tmp/ralphi-notify/docs/prds/release.md',
    title: 'Release flow',
    done: false
  });

  const settings = defaultNotificationSettings();
  settings.channels.slack = { enabled: true, url: 'https://hooks.slack.com/services/T/B/C' };
  settings.channels.discord = { enabled: true, url: 'https://discord.com/api/webhooks/1/2' };
  settings.channels.ntfy = { enabled: true, url: 'https://ntfy.sh/ralphi-test' };

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await dispatchProjectNotification(settings, {
      event: 'failure',
      rootDir: '/tmp/ralphi-notify',
      provider: 'copilot',
      schedule: 'parallel',
      contexts: [context],
      errorMessage: 'boom'
    });

    assert.deepEqual(result.attempted, ['slack', 'discord', 'ntfy']);
    assert.deepEqual(result.delivered, ['slack', 'discord', 'ntfy']);
    assert.equal(result.failures.length, 0);

    const slackBody = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(slackBody.text.includes('Ralphi attention needed'), true);
    assert.equal(Array.isArray(slackBody.blocks), true);

    const discordBody = JSON.parse(String(calls[1]?.init?.body));
    assert.equal(typeof discordBody.content, 'string');
    assert.deepEqual(discordBody.allowed_mentions, { parse: [] });

    assert.equal(calls[2]?.init?.headers instanceof Headers, false);
    const ntfyHeaders = calls[2]?.init?.headers as Record<string, string>;
    assert.equal(ntfyHeaders.Title.includes('Ralphi attention needed'), true);
    assert.equal(ntfyHeaders.Priority, 'high');
  } finally {
    global.fetch = originalFetch;
  }
});

