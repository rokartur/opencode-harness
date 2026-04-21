import { readFileText, fileExists } from "../shared/fs.js";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, MAX_HOOKS_PER_PLUGIN } from "../shared/limits.js";
import type { CompatHook, PluginDiagnostic } from "../shared/types.js";

export function loadHooksFromPlugin(
  pluginDir: string,
  hooksFile: string,
  diagnostics: PluginDiagnostic[] = [],
  pluginName: string = basename(pluginDir),
): CompatHook[] {
  const primary = `${pluginDir}/${hooksFile}`;
  const fallback = `${pluginDir}/hooks/hooks.json`;

  let raw: string | null = null;
  if (fileExists(primary)) {
    raw = readFileText(primary);
  } else if (fileExists(fallback)) {
    raw = readFileText(fallback);
  }

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return parseHooksObject(parsed, pluginDir, diagnostics, pluginName);
  } catch (error) {
    diagnostics.push({
      level: "error",
      pluginName,
      message: `Malformed hooks file '${hooksFile}'`,
      detail: String(error),
    });
    return [];
  }
}

function parseHooksObject(
  raw: unknown,
  pluginRoot: string,
  diagnostics: PluginDiagnostic[],
  pluginName: string,
): CompatHook[] {
  if (typeof raw !== "object" || raw == null) {
    diagnostics.push({
      level: "error",
      pluginName,
      message: "Malformed hooks payload: expected object",
    });
    return [];
  }

  const hooksData = (raw as Record<string, unknown>)["hooks"] ?? raw;
  if (typeof hooksData !== "object" || hooksData == null || Array.isArray(hooksData)) {
    diagnostics.push({
      level: "error",
      pluginName,
      message: "Malformed hooks payload: expected event map",
    });
    return [];
  }

  const hooks: CompatHook[] = [];

  for (const [event, entries] of Object.entries(hooksData as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (hooks.length >= MAX_HOOKS_PER_PLUGIN) return hooks;

      if (typeof entry === "object" && entry != null && !Array.isArray(entry)) {
        if ("hooks" in entry && Array.isArray((entry as Record<string, unknown>)["hooks"])) {
          const matcher = String((entry as Record<string, unknown>)["matcher"] ?? "");
          const subHooks = (entry as Record<string, unknown>)["hooks"] as Record<string, unknown>[];
          for (const h of subHooks) {
            const hook = parseSingleHook(event, h, pluginRoot, diagnostics, pluginName, matcher);
            if (hook) hooks.push(hook);
          }
        } else {
          const hook = parseSingleHook(
            event,
            entry as Record<string, unknown>,
            pluginRoot,
            diagnostics,
            pluginName,
          );
          if (hook) hooks.push(hook);
        }
      }
    }
  }

  return hooks;
}

function parseSingleHook(
  event: string,
  hook: Record<string, unknown>,
  pluginRoot: string,
  diagnostics: PluginDiagnostic[],
  pluginName: string,
  outerMatcher?: string,
): CompatHook | null {
  const kind = String(hook["type"] ?? "command") as CompatHook["kind"];
  if (!["command", "http", "prompt", "agent"].includes(kind)) {
    diagnostics.push({
      level: "warn",
      pluginName,
      message: `Unsupported hook kind '${kind}' on event '${event}'`,
    });
    return null;
  }

  const matcher =
    outerMatcher ?? (typeof hook["matcher"] === "string" ? hook["matcher"] : undefined);
  const timeout =
    typeof hook["timeout"] === "number"
      ? hook["timeout"]
      : typeof hook["timeoutSeconds"] === "number"
        ? hook["timeoutSeconds"]
        : DEFAULT_HOOK_TIMEOUT_SECONDS;

  const result: CompatHook = {
    event,
    kind,
    matcher,
    timeoutSeconds: Math.max(1, Math.min(600, timeout)),
    blockOnFailure:
      typeof hook["blockOnFailure"] === "boolean" ? hook["blockOnFailure"] : kind !== "command",
  };

  if (kind === "command" && typeof hook["command"] === "string") {
    result.command = (hook["command"] as string).replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  } else if (kind === "http") {
    if (typeof hook["url"] === "string") result.url = hook["url"];
    else {
      diagnostics.push({
        level: "error",
        pluginName,
        message: `Malformed http hook for event '${event}': missing url`,
      });
      return null;
    }
    result.headers =
      typeof hook["headers"] === "object" && hook["headers"] != null
        ? (hook["headers"] as Record<string, string>)
        : undefined;
  } else if ((kind === "prompt" || kind === "agent") && typeof hook["prompt"] === "string") {
    diagnostics.push({
      level: "warn",
      pluginName,
      message: `Degraded hook support for '${kind}' on event '${event}'`,
    });
    result.prompt = hook["prompt"];
  } else {
    diagnostics.push({
      level: "error",
      pluginName,
      message: `Malformed ${kind} hook for event '${event}'`,
    });
    return null;
  }

  return result;
}

function basename(path: string): string {
  return path.split("/").pop() ?? "unknown";
}
