import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { ensureDir, dirExists } from "../shared/fs.js";

export function getProjectMemoryDir(cwd: string): string {
  const resolved = resolvePath(cwd);
  const digest = sha1(resolved).slice(0, 12);
  const base = join(homedir(), ".openharness", "data", "memory");
  const memoryDir = join(base, `${resolved.split("/").pop()}-${digest}`);
  ensureDir(memoryDir);
  return memoryDir;
}

export function getMemoryEntrypoint(cwd: string): string {
  return join(getProjectMemoryDir(cwd), "MEMORY.md");
}

function resolvePath(p: string): string {
  return resolve(p);
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
