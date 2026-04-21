import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { dirExists, listDirEntries, findManifestPath } from "../shared/fs.js";
import { parseManifest } from "./manifest.js";
import { loadCommandsFromPlugin } from "./commands.js";
import { loadAgentsFromPlugin } from "./agents.js";
import { loadSkillsFromPlugin } from "./skills.js";
import { loadMcpFromPlugin } from "./mcp.js";
import { loadHooksFromPlugin } from "./hooks.js";
import { mapOpenHarnessEventToOpenCode } from "./hooks-executor.js";
import type {
  LoadedCompatPlugin,
  PluginDiagnostic,
  PluginConfig,
  CompatibilityReport,
} from "../shared/types.js";

export function discoverPluginRoots(cwd: string, config?: PluginConfig): string[] {
  const roots: string[] = [
    join(homedir(), ".openharness", "plugins"),
    join(cwd, ".openharness", "plugins"),
  ];

  if (config?.extraPluginRoots) {
    for (const root of config.extraPluginRoots) {
      roots.push(root);
    }
  }

  return Array.from(new Set(roots.map((root) => resolve(root))));
}

export function discoverPluginDirs(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const root of roots) {
    if (!dirExists(root)) continue;
    for (const entry of listDirEntries(root)) {
      const full = join(root, entry);
      if (seen.has(full)) continue;
      if (!dirExists(full)) continue;
      if (findManifestPath(full)) {
        seen.add(full);
        result.push(full);
      }
    }
  }

  return result;
}

export function loadPluginsFromDirs(
  pluginDirs: string[],
  config?: PluginConfig,
  cwd?: string,
): LoadedCompatPlugin[] {
  const plugins: LoadedCompatPlugin[] = [];
  const projectRoot = cwd ? resolve(join(cwd, ".openharness", "plugins")) : null;
  const extraRoots = new Set((config?.extraPluginRoots ?? []).map((root) => resolve(root)));

  for (const dir of pluginDirs) {
    const parsed = parseManifest(dir);
    if (!parsed) continue;

    const { manifest, diagnostics: parseDiag } = parsed;
    const diagnostics = [...parseDiag];
    const source = classifyPluginSource(dir, projectRoot, extraRoots);
    const blockedByPolicy = source === "project" && config?.allowProjectPlugins !== true;
    const hasManifestError = parseDiag.some((d) => d.level === "error");
    const shouldLoadArtifacts = !blockedByPolicy && !hasManifestError;
    const enabled = shouldLoadArtifacts && manifest.enabledByDefault;

    if (blockedByPolicy) {
      diagnostics.push({
        level: "warn",
        pluginName: manifest.name,
        message: "Project-local plugin discovered but blocked by default policy",
      });
    }

    const commands = shouldLoadArtifacts
      ? loadCommandsFromPlugin(dir, manifest.name, manifest.commands)
      : [];
    const agents = shouldLoadArtifacts
      ? loadAgentsFromPlugin(dir, manifest.name, manifest.agents, diagnostics)
      : [];
    const skills = shouldLoadArtifacts ? loadSkillsFromPlugin(dir, manifest.skillsDir) : [];
    const mcpServers = shouldLoadArtifacts
      ? loadMcpFromPlugin(dir, manifest.mcpFile, diagnostics, manifest.name)
      : {};
    const hooks =
      shouldLoadArtifacts && config?.enableHooks !== false
        ? loadHooksFromPlugin(dir, manifest.hooksFile, diagnostics, manifest.name)
        : [];

    reportHookDiagnostics(hooks, manifest.name, diagnostics);

    plugins.push({
      manifest,
      rootDir: dir,
      source,
      enabled,
      blockedByPolicy,
      commands,
      agents,
      hooks,
      skills,
      mcpServers,
      diagnostics,
    });
  }

  return plugins;
}

export function buildCompatibilityReport(plugins: LoadedCompatPlugin[]): CompatibilityReport {
  const diagnostics: PluginDiagnostic[] = [];
  let commands = 0;
  let agents = 0;
  let hooks = 0;
  let skills = 0;
  let mcpServers = 0;
  let enabled = 0;
  let blocked = 0;

  for (const p of plugins) {
    diagnostics.push(...p.diagnostics);
    if (p.blockedByPolicy) blocked++;
    if (p.enabled) {
      enabled++;
      commands += p.commands.length;
      agents += p.agents.length;
      hooks += p.hooks.length;
      skills += p.skills.length;
      mcpServers += Object.keys(p.mcpServers).length;
    }
  }

  return {
    discovered: plugins.length,
    loaded: plugins.length,
    enabled,
    blocked,
    commands,
    agents,
    hooks,
    skills,
    mcpServers,
    malformed: diagnostics.filter((d) => d.level === "error").length,
    degraded: diagnostics.filter((d) => /degraded|unsupported/i.test(d.message)).length,
    diagnostics,
  };
}

function classifyPluginSource(
  dir: string,
  projectRoot: string | null,
  extraRoots: Set<string>,
): "user" | "project" | "extra" {
  const resolved = resolve(dir);
  if (projectRoot && isWithinRoot(resolved, projectRoot)) return "project";
  for (const root of extraRoots) {
    if (isWithinRoot(resolved, root)) return "extra";
  }
  return "user";
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

function reportHookDiagnostics(
  hooks: ReturnType<typeof loadHooksFromPlugin>,
  pluginName: string,
  diagnostics: PluginDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (mapOpenHarnessEventToOpenCode(hook.event).length > 0) continue;
    const key = `${hook.event}:${hook.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      level: "warn",
      pluginName,
      message: `Degraded hook mapping for event '${hook.event}'`,
    });
  }
}
