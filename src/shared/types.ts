export interface CompatManifest {
  name: string;
  version: string;
  description: string;
  enabledByDefault: boolean;
  skillsDir: string;
  hooksFile: string;
  mcpFile: string;
  commands?: string | string[] | Record<string, unknown>;
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | Record<string, unknown> | unknown[];
}

export interface CompatCommand {
  name: string;
  description: string;
  template: string;
  model?: string;
  agent?: string;
  argumentHint?: string;
  effort?: string | number;
  whenToUse?: string;
  displayName?: string;
  source: string;
}

export interface CompatAgent {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  color?: string;
  mode: "primary" | "subagent";
  temperature?: number;
  steps?: number;
  source: string;
}

export interface CompatHook {
  event: string;
  kind: "command" | "http" | "prompt" | "agent";
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  prompt?: string;
  matcher?: string;
  timeoutSeconds: number;
  blockOnFailure: boolean;
}

export interface CompatMcpServer {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface CompatSkill {
  name: string;
  description: string;
  content: string;
  source: string;
}

export interface LoadedCompatPlugin {
  manifest: CompatManifest;
  rootDir: string;
  source: "user" | "project" | "extra";
  enabled: boolean;
  blockedByPolicy?: boolean;
  commands: CompatCommand[];
  agents: CompatAgent[];
  hooks: CompatHook[];
  skills: CompatSkill[];
  mcpServers: Record<string, CompatMcpServer>;
  diagnostics: PluginDiagnostic[];
}

export interface PluginDiagnostic {
  level: "info" | "warn" | "error";
  pluginName: string;
  message: string;
  detail?: string;
}

export interface CompatibilityReport {
  discovered: number;
  loaded: number;
  enabled: number;
  blocked: number;
  commands: number;
  agents: number;
  hooks: number;
  skills: number;
  mcpServers: number;
  malformed: number;
  degraded: number;
  diagnostics: PluginDiagnostic[];
}

export interface PluginConfig {
  allowProjectPlugins?: boolean;
  extraPluginRoots?: string[];
  // Deprecated: only full namespacing is supported.
  namespaceMode?: "full" | "short";
  enableHooks?: boolean;
  enableMemory?: boolean;
  enableCompaction?: boolean;
  enableClaudeRulesCompat?: boolean;
  enableIssueContext?: boolean;
  enablePrCommentsContext?: boolean;
  enableActiveRepoContext?: boolean;
}
