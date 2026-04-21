import { readFileText, walkMarkdownFiles, dirExists, fileExists } from "../shared/fs.js";
import { parseFrontmatter, extractDescription } from "../shared/frontmatter.js";
import { MAX_CHARS_PER_COMMAND_BODY, MAX_COMMANDS_PER_PLUGIN } from "../shared/limits.js";
import type { CompatCommand } from "../shared/types.js";

export function loadCommandsFromPlugin(
  pluginDir: string,
  pluginName: string,
  manifestCommands?: string | string[] | Record<string, unknown>,
): CompatCommand[] {
  const commands: CompatCommand[] = [];
  const seen = new Set<string>();

  const defaultDir = `${pluginDir}/commands`;
  loadCommandsFromDir(defaultDir, pluginName, commands, seen);

  if (manifestCommands != null) {
    if (Array.isArray(manifestCommands)) {
      for (const raw of manifestCommands) {
        const target = `${pluginDir}/${String(raw)}`;
        loadCommandsFromDirOrFile(target, pluginName, commands, seen);
      }
    } else if (typeof manifestCommands === "string") {
      loadCommandsFromDirOrFile(`${pluginDir}/${manifestCommands}`, pluginName, commands, seen);
    } else if (typeof manifestCommands === "object") {
      for (const [cmdName, meta] of Object.entries(manifestCommands)) {
        if (typeof meta !== "object" || meta == null) continue;
        const m = meta as Record<string, unknown>;
        const source = m["source"];
        const content = m["content"];

        if (typeof source === "string") {
          loadCommandsFromDirOrFile(`${pluginDir}/${source}`, pluginName, commands, seen);
        } else if (typeof content === "string") {
          const name = `${pluginName}:${cmdName}`;
          if (seen.has(name)) continue;
          seen.add(name);
          commands.push({
            name,
            description: String(m["description"] ?? `Command from ${pluginName}`).trim(),
            template: content.slice(0, MAX_CHARS_PER_COMMAND_BODY).trim(),
            model: typeof m["model"] === "string" ? m["model"] : undefined,
            argumentHint: typeof m["argumentHint"] === "string" ? m["argumentHint"] : undefined,
            source: "plugin",
          });
        }
      }
    }
  }

  return commands.slice(0, MAX_COMMANDS_PER_PLUGIN);
}

function loadCommandsFromDir(
  dir: string,
  pluginName: string,
  commands: CompatCommand[],
  seen: Set<string>,
): void {
  const files = walkMarkdownFiles(dir, true);

  for (const filePath of files) {
    const relative = filePath.slice(dir.length + 1);
    const parts = relative.replace(/\.md$/i, "").split("/");
    const isSkillFile = parts[parts.length - 1].toLowerCase() === "skill";
    const cmdBase = isSkillFile && parts.length > 1 ? parts[parts.length - 2] : parts.join(":");
    const name = `${pluginName}:${cmdBase}`;

    if (seen.has(name)) continue;
    seen.add(name);

    const raw = readFileText(filePath);
    if (!raw) continue;

    const { data, body } = parseFrontmatter(raw);
    const desc = extractDescription(data, body, `Command from ${pluginName}`);

    commands.push({
      name,
      description: desc.slice(0, 1024),
      template: body.slice(0, MAX_CHARS_PER_COMMAND_BODY),
      model: typeof data["model"] === "string" ? data["model"] : undefined,
      agent: typeof data["agent"] === "string" ? data["agent"] : undefined,
      argumentHint: typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined,
      effort: typeof data["effort"] === "string" || typeof data["effort"] === "number" ? data["effort"] as string | number : undefined,
      whenToUse: typeof data["when_to_use"] === "string" ? data["when_to_use"] : undefined,
      displayName: typeof data["name"] === "string" ? data["name"] : undefined,
      source: "plugin",
    });
  }
}

function loadCommandsFromDirOrFile(
  target: string,
  pluginName: string,
  commands: CompatCommand[],
  seen: Set<string>,
): void {
  if (dirExists(target)) {
    loadCommandsFromDir(target, pluginName, commands, seen);
    return;
  }
  if (!fileExists(target) || !target.toLowerCase().endsWith(".md")) return;

  const stem = target.replace(/\.md$/i, "").split("/").pop()!;
  const name = `${pluginName}:${stem}`;
  if (seen.has(name)) return;
  seen.add(name);

  const raw = readFileText(target);
  if (!raw) return;

  const { data, body } = parseFrontmatter(raw);
  const desc = extractDescription(data, body, `Command from ${pluginName}`);

  commands.push({
    name,
    description: desc.slice(0, 1024),
    template: body.slice(0, MAX_CHARS_PER_COMMAND_BODY),
    model: typeof data["model"] === "string" ? data["model"] : undefined,
    agent: typeof data["agent"] === "string" ? data["agent"] : undefined,
    argumentHint: typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined,
    effort: typeof data["effort"] === "string" || typeof data["effort"] === "number" ? data["effort"] as string | number : undefined,
    whenToUse: typeof data["when_to_use"] === "string" ? data["when_to_use"] : undefined,
    displayName: typeof data["name"] === "string" ? data["name"] : undefined,
    source: "plugin",
  });
}
