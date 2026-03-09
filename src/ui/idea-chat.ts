import {
  IDEA_MODE_MAX_DERAIL_INSISTENCE,
  IDEA_MODE_MAX_PROVIDER_QUESTIONS,
  type IdeaConversationProgress,
  type IdeaTranscriptEntry
} from '../core/idea.js';
import type { ProviderName } from '../core/types.js';

export interface IdeaChatLine {
  key: string;
  role: IdeaTranscriptEntry['role'];
  kind: IdeaTranscriptEntry['kind'];
  text: string;
}

export function flattenIdeaTranscript(entries: IdeaTranscriptEntry[]): IdeaChatLine[] {
  return entries.flatMap((entry, entryIndex) => {
    const prefix = entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Ralphi' : 'System';
    const lines = entry.content.split(/\r?\n/);

    return lines.map((line, lineIndex) => ({
      key: `idea-${entryIndex}-${lineIndex}`,
      role: entry.role,
      kind: entry.kind,
      text: `${lineIndex === 0 ? `${prefix} · ` : '       '}${line}`
    }));
  });
}

export function buildIdeaStatusLines(options: {
  provider: ProviderName;
  progress: IdeaConversationProgress;
  loading: boolean;
  loadingLabel?: string | null;
}): string[] {
  return [
    `Provider · ${options.provider}`,
    `Questions · ${options.progress.providerQuestionsAsked}/${IDEA_MODE_MAX_PROVIDER_QUESTIONS}`,
    `Derails · ${options.progress.derailInsistenceCount}/${IDEA_MODE_MAX_DERAIL_INSISTENCE}`,
    options.loading ? `Status · Thinking${options.loadingLabel ? ` · ${options.loadingLabel}` : ''}` : 'Status · Waiting for your reply'
  ];
}
