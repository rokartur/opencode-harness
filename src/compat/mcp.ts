import { readFileText, fileExists } from "../shared/fs.js";
import { MAX_MCP_SERVERS_PER_PLUGIN } from "../shared/limits.js";
import type { CompatMcpServer, PluginDiagnostic } from "../shared/types.js";

export function loadMcpFromPlugin(
  pluginDir: string,
  mcpFile: string,
  diagnostics: PluginDiagnostic[] = [],
  pluginName: string = basename(pluginDir),
): Record<string, CompatMcpServer> {
  const primary = `${pluginDir}/${mcpFile}`;
  const fallback = `${pluginDir}/.mcp.json`;

  let raw: string | null = null;
  if (fileExists(primary)) {
    raw = readFileText(primary);
  } else if (fileExists(fallback)) {
    raw = readFileText(fallback);
  }

  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed["mcpServers"] ?? parsed;
    if (typeof servers !== "object" || servers == null || Array.isArray(servers)) {
      diagnostics.push({
        level: "error",
        pluginName,
        message: `Malformed MCP file '${mcpFile}': expected object map`,
      });
      return {};
    }

    const result: Record<string, CompatMcpServer> = {};
    let count = 0;

    for (const [name, config] of Object.entries(servers)) {
      if (count >= MAX_MCP_SERVERS_PER_PLUGIN) break;
      if (typeof config !== "object" || config == null) {
        diagnostics.push({
          level: "warn",
          pluginName,
          message: `Skipping malformed MCP server '${name}'`,
        });
        continue;
      }
      result[name] = { ...config } as CompatMcpServer;
      count++;
    }

    return result;
  } catch (error) {
    diagnostics.push({
      level: "error",
      pluginName,
      message: `Malformed MCP file '${mcpFile}'`,
      detail: String(error),
    });
    return {};
  }
}

function basename(path: string): string {
  return path.split("/").pop() ?? "unknown";
}
