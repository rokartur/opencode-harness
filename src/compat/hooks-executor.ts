import { spawn } from "node:child_process";
import type { CompatHook } from "../shared/types.js";

export interface HookResult {
  hook: CompatHook;
  success: boolean;
  blocked: boolean;
  output: string;
  reason?: string;
}

const MAX_OUTPUT_BYTES = 512 * 1024;
const SAFE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "BUN_INSTALL",
]);

const PRIVATE_IP_RANGES = [
  { start: 0x0a000000, end: 0x0affffff },
  { start: 0x7f000000, end: 0x7fffffff },
  { start: 0xa9fe0000, end: 0xa9feffff },
  { start: 0xac100000, end: 0xac1fffff },
  { start: 0xc0a80000, end: 0xc0a8ffff },
];

const globCache = new Map<string, RegExp>();

export async function executeHook(
  hook: CompatHook,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<HookResult> {
  if (hook.kind === "command") {
    return executeCommandHook(hook, payload, cwd);
  }
  if (hook.kind === "http") {
    return executeHttpHook(hook, payload);
  }
  return {
    hook,
    success: false,
    blocked: false,
    output: "",
    reason: `Unsupported hook kind: ${hook.kind}`,
  };
}

function executeCommandHook(
  hook: CompatHook,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<HookResult> {
  if (!hook.command) {
    return Promise.resolve({
      hook,
      success: false,
      blocked: false,
      output: "",
      reason: "No command defined",
    });
  }

  if (!isSafeCommand(hook.command)) {
    return Promise.resolve({
      hook,
      success: false,
      blocked: hook.blockOnFailure,
      output: "",
      reason: `Hook command blocked: contains disallowed pattern`,
    });
  }

  const command = injectArguments(hook.command, payload);

  return new Promise((resolve) => {
    const env = buildSafeEnv(hook.event, payload);

    const proc = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_OUTPUT_BYTES) {
        if (!stdoutTruncated) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
          if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutTruncated = true;
        }
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > MAX_OUTPUT_BYTES) {
        if (!stderrTruncated) {
          const remaining = MAX_OUTPUT_BYTES - stderrBytes;
          if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
          stderrTruncated = true;
        }
        return;
      }
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
    }, hook.timeoutSeconds * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const stdout =
        Buffer.concat(stdoutChunks).toString("utf-8").trim() +
        (stdoutTruncated ? "\n[output truncated]" : "");
      const stderr =
        Buffer.concat(stderrChunks).toString("utf-8").trim() +
        (stderrTruncated ? "\n[output truncated]" : "");
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const success = code === 0;

      resolve({
        hook,
        success,
        blocked: hook.blockOnFailure && !success,
        output,
        reason: success ? undefined : output || `Command hook exited with code ${code}`,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        hook,
        success: false,
        blocked: hook.blockOnFailure,
        output: "",
        reason: err.message,
      });
    });
  });
}

async function executeHttpHook(
  hook: CompatHook,
  payload: Record<string, unknown>,
): Promise<HookResult> {
  if (!hook.url) {
    return {
      hook,
      success: false,
      blocked: false,
      output: "",
      reason: "No URL defined for HTTP hook",
    };
  }

  const urlError = validateHookUrl(hook.url);
  if (urlError) {
    return {
      hook,
      success: false,
      blocked: hook.blockOnFailure,
      output: "",
      reason: urlError,
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...hook.headers,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), hook.timeoutSeconds * 1000);

    const response = await fetch(hook.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: hook.event, payload }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await response.text();
    const success = response.status >= 200 && response.status < 300;

    return {
      hook,
      success,
      blocked: hook.blockOnFailure && !success,
      output: text,
      reason: success ? undefined : `HTTP hook returned ${response.status}`,
    };
  } catch (err) {
    return {
      hook,
      success: false,
      blocked: hook.blockOnFailure,
      output: "",
      reason: String(err),
    };
  }
}

function buildSafeEnv(event: string, payload: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === "string") env[key] = val;
  }
  env.OPENHARNESS_HOOK_EVENT = event;
  env.OPENHARNESS_HOOK_PAYLOAD = sanitizePayload(payload);
  return env;
}

function sanitizePayload(payload: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else if (value == null) {
      safe[key] = null;
    } else {
      safe[key] = String(value).slice(0, 200);
    }
  }
  return JSON.stringify(safe);
}

function isSafeCommand(command: string): boolean {
  const blocked = [
    /\brm\s+-rf\s+\//,
    /\b(?:wget|curl)\s+.*\|\s*sh/,
    /\bdd\s+if=/,
    />\s*\/dev\/sd/,
    /\bchmod\s+777/,
  ];
  for (const pattern of blocked) {
    if (pattern.test(command)) return false;
  }
  return true;
}

function validateHookUrl(urlStr: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return `Invalid URL: ${urlStr}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname;
  if (!hostname) return "Missing hostname";

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return `Hook URL targets local address: ${hostname}`;
  }

  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const ip =
      ((parseInt(ipv4Match[1]) << 24) >>> 0) +
      (parseInt(ipv4Match[2]) << 16) +
      (parseInt(ipv4Match[3]) << 8) +
      parseInt(ipv4Match[4]);
    for (const range of PRIVATE_IP_RANGES) {
      if (ip >= range.start && ip <= range.end) {
        return `Hook URL targets private IP: ${hostname}`;
      }
    }
  }

  return null;
}

export function matchesHook(hook: CompatHook, subject: string): boolean {
  if (!hook.matcher) return true;
  return globMatch(subject, hook.matcher);
}

function globMatch(str: string, pattern: string): boolean {
  let regex = globCache.get(pattern);
  if (!regex) {
    if (pattern.length > 200) return false;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    regex = new RegExp(`^${escaped}$`);
    if (globCache.size > 500) globCache.clear();
    globCache.set(pattern, regex);
  }
  return regex.test(str);
}

function injectArguments(template: string, payload: Record<string, unknown>): string {
  const safeJson = sanitizePayload(payload);
  return template.replace("$ARGUMENTS", safeJson);
}

export function mapOpenHarnessEventToOpenCode(ohEvent: string): string[] {
  const mapping: Record<string, string[]> = {
    pre_tool_use: ["tool.execute.before"],
    post_tool_use: ["tool.execute.after"],
    pre_compact: ["experimental.session.compacting"],
    post_compact: ["session.compacted"],
    session_start: ["session.created"],
    session_end: ["session.deleted"],
    notification: [],
    stop: [],
    subagent_stop: [],
    user_prompt_submit: [],
  };
  return mapping[ohEvent] ?? [];
}
