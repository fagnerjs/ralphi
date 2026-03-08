export type ProviderName = 'amp' | 'claude' | 'codex' | 'copilot' | 'cursor' | 'gemini' | 'opencode' | 'qwen';
export type ScheduleMode = 'round-robin' | 'per-prd' | 'parallel';
export type LaunchMode = 'run-existing' | 'create-prd';
export type WorkspaceStrategy = 'shared' | 'worktree';
export type SkillScope = 'project' | 'global';
export type SkillSourceKind = 'codex-system' | 'codex-curated' | 'claude-catalog' | 'github' | 'local';
export type SkillInstallTarget = 'ralphi' | 'amp' | 'codex' | 'claude' | 'copilot' | 'opencode' | 'qwen';
export type ExecutionEnvironment = 'local' | 'devcontainer';
export type RalphStatus = 'queued' | 'booting' | 'running' | 'complete' | 'blocked' | 'error';
export type BacklogStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'disabled';
export type BacklogItemSource = 'prd' | 'custom';
export type ProjectContextMode = 'contextual' | 'global';
export type DoctorCheckStatus = 'ok' | 'warning' | 'blocking';
export type ResumeSafety = 'safe_resume' | 'warn_resume' | 'must_restart';
export type NotificationChannel = 'slack' | 'teams' | 'discord' | 'google-chat' | 'mattermost' | 'ntfy' | 'generic';
export type RalphFailureCategory =
  | 'provider_launch'
  | 'provider_runtime'
  | 'timeout'
  | 'git'
  | 'skill'
  | 'invalid_output'
  | 'mcp_startup'
  | 'unknown';
export type RalphTouchedFileChange = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'unknown';
export type RalphMcpServerState = 'ready' | 'failed';

export interface SkillInstallSpec {
  id: string;
  name: string;
  scope: SkillScope;
  source: SkillSourceKind;
  target: SkillInstallTarget;
  repo?: string;
  path?: string;
  ref?: string;
  description?: string;
}

export interface RalphExecutionSkill {
  id: string;
  name: string;
  provider: ProviderName;
  sourcePath: string;
  description?: string;
  persisted: boolean;
}

export interface NotificationEventPreferences {
  start: boolean;
  success: boolean;
  failure: boolean;
}

export interface NotificationChannelConfig {
  enabled: boolean;
  url: string;
}

export interface RalphiNotificationSettings {
  events: NotificationEventPreferences;
  channels: Partial<Record<NotificationChannel, NotificationChannelConfig>>;
}

export interface RalphiProjectConfig {
  version: number;
  defaults: {
    tool?: ProviderName;
    schedule?: ScheduleMode;
    verbose?: boolean;
    workspaceStrategy?: WorkspaceStrategy;
    iterations?: number;
    environment?: ExecutionEnvironment;
  };
  notifications: RalphiNotificationSettings;
  skills: SkillInstallSpec[];
}

export interface RalphiGlobalRegistry {
  version: number;
  skills: SkillInstallSpec[];
}

export interface BacklogStep {
  id: string;
  title: string;
  status: BacklogStatus;
}

export interface BacklogItem {
  id: string;
  storyId: string;
  title: string;
  description: string;
  status: BacklogStatus;
  notes: string;
  steps: BacklogStep[];
  updatedAt: string;
  source: BacklogItemSource;
  manualTitle?: string | null;
  manualDescription?: string | null;
}

export interface BacklogSnapshot {
  items: BacklogItem[];
  totalItems: number;
  completedItems: number;
  totalSteps: number;
  completedSteps: number;
  activeItemId: string | null;
  activeStepId: string | null;
}

export interface GitValidation {
  repository: boolean;
  rootDir: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  defaultRemote: string | null;
  clean: boolean;
  dirtyEntries: string[];
  warnings: string[];
  worktreeRoot: string;
}

export interface RalphUsageTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
  currency: string | null;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  detail?: string | null;
}

export interface DoctorReport {
  generatedAt: string;
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
  counts: Record<DoctorCheckStatus, number>;
}

export interface ResumeDriftIssue {
  id: string;
  severity: 'warning' | 'blocking';
  label: string;
  detail: string;
}

export interface ResumeDriftReport {
  comparedAt: string;
  classification: ResumeSafety;
  issues: ResumeDriftIssue[];
}

export interface RalphFailureInfo {
  category: RalphFailureCategory;
  retryable: boolean;
  retryCount: number;
  summary: string;
  recoveryHint: string;
  rawLogPath: string | null;
}

export interface RalphTouchedFile {
  path: string;
  change: RalphTouchedFileChange;
}

export interface RalphMcpServerStatus {
  name: string;
  state: RalphMcpServerState;
  detail: string;
  updatedAt: string;
}

export interface RalphIterationSnapshot {
  iteration: number;
  attempt: number;
  durationMs: number;
  exitCode: number;
  lineCount: number;
  lastStep: string;
  logPath: string;
  promptPath: string;
  promptPreviewPath: string;
  promptSourcesPath: string;
  touchedFiles: RalphTouchedFile[];
  usageTotals: RalphUsageTotals | null;
  mcpServers: RalphMcpServerStatus[];
  failure: RalphFailureInfo | null;
  completed: boolean;
}

export interface RalphFileFingerprint {
  path: string;
  exists: boolean;
  sha1: string | null;
}

export interface RalphPlanResumeFingerprint {
  planId: string;
  stateKey: string;
  sourcePrd: RalphFileFingerprint;
  backlog: RalphFileFingerprint;
}

export interface RalphSessionResumeFingerprint {
  projectConfig: RalphFileFingerprint;
  plans: RalphPlanResumeFingerprint[];
}

export interface RalphPrdPlan {
  id: string;
  stateKey: string;
  variantIndex: number | null;
  variantCount: number | null;
  title: string;
  sourcePrd: string;
  iterations: number;
  branchName: string | null;
  dependsOn: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  backlogPath: string | null;
  resetBacklog: boolean;
}

export interface RalphConfig {
  rootDir: string;
  ralphDir: string;
  tool: ProviderName;
  executionSkills: RalphExecutionSkill[];
  plans: RalphPrdPlan[];
  maxIterations: number;
  schedule: ScheduleMode;
  verbose: boolean;
  workspaceStrategy: WorkspaceStrategy;
  executionEnvironment: ExecutionEnvironment;
  devcontainerConfigPath: string | null;
  launchMode: LaunchMode;
  createPrdPrompt?: string;
  projectConfigPath: string;
  projectConfig: RalphiProjectConfig;
  projectConfigCreated: boolean;
  projectContextMode: ProjectContextMode;
}

export interface RalphContextSnapshot {
  index: number;
  planId: string;
  sourcePrd: string;
  sourceLabel: string;
  title: string;
  dependsOnPlanId: string | null;
  dependsOnTitle: string | null;
  runSlug: string;
  runDir: string;
  logDir: string;
  prdJsonPath: string;
  progressFilePath: string;
  backlogPath: string;
  workspaceDir: string;
  branchName: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  storyProgress: string;
  backlogProgress: string;
  backlog: BacklogSnapshot | null;
  status: RalphStatus;
  done: boolean;
  iterationsRun: number;
  iterationsTarget: number;
  lastLogPath: string | null;
  activeBacklogItemId: string | null;
  activeBacklogStepId: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  usageTotals: RalphUsageTotals | null;
  lastStep: string;
  lastError: string | null;
  lastFailure: RalphFailureInfo | null;
  iterationHistory: RalphIterationSnapshot[];
  lastPromptPath: string | null;
  lastPromptPreviewPath: string | null;
  lastPromptSourcesPath: string | null;
  mcpServers: RalphMcpServerStatus[];
}

export interface RalphRunSummary {
  completed: boolean;
  tool: ProviderName;
  schedule: ScheduleMode;
  maxIterations: number;
  usageTotals: RalphUsageTotals | null;
  finalBranchName: string | null;
  contexts: RalphContextSnapshot[];
}

export type RalphiRunSessionStatus = 'running' | 'blocked' | 'complete';

export interface RalphiRunSession {
  version: number;
  createdAt: string;
  updatedAt: string;
  status: RalphiRunSessionStatus;
  config: RalphConfig;
  summary: RalphRunSummary | null;
  resumeFingerprint: RalphSessionResumeFingerprint | null;
}

export type RalphEvent =
  | {
      type: 'doctor-report';
      report: DoctorReport;
    }
  | {
      type: 'project-config';
      configPath: string;
      created: boolean;
      missingSkillCount: number;
    }
  | {
      type: 'skill-sync-start';
      total: number;
    }
  | {
      type: 'skill-sync-progress';
      current: number;
      total: number;
      skill: SkillInstallSpec;
      targetDir: string;
    }
  | {
      type: 'skill-sync-finish';
      total: number;
    }
  | {
      type: 'git-validation';
      validation: GitValidation;
    }
  | {
      type: 'boot-log';
      level: 'info' | 'warning' | 'success' | 'error';
      message: string;
      contextIndex?: number;
    }
  | {
      type: 'prepared';
      contexts: RalphContextSnapshot[];
    }
  | {
      type: 'worktree-ready';
      context: RalphContextSnapshot;
      created: boolean;
    }
  | {
      type: 'wave-start';
      wave: number;
      totalWaves: number;
    }
  | {
      type: 'track-start';
      contextIndex: number;
      totalContexts: number;
      sourcePrd: string;
    }
  | {
      type: 'backlog-update';
      contextIndex: number;
      backlog: BacklogSnapshot;
      itemId: string | null;
      stepId: string | null;
    }
  | {
      type: 'iteration-start';
      context: RalphContextSnapshot;
      prdIteration: number;
      trackLabel: string;
      phaseLabel: string;
    }
  | {
      type: 'iteration-output';
      contextIndex: number;
      line: string;
      step: string;
    }
  | {
      type: 'iteration-finish';
      context: RalphContextSnapshot;
      prdIteration: number;
      trackLabel: string;
      step: string;
      logPath: string;
      durationMs: number;
      lineCount: number;
      exitCode: number;
      completed: boolean;
    }
  | {
      type: 'summary';
      summary: RalphRunSummary;
    };

export type RalphReporter = (event: RalphEvent) => void | Promise<void>;
