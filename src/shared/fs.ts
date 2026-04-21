import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";

export function readFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function ensureDir(path: string): void {
  if (!dirExists(path)) mkdirSync(path, { recursive: true });
}

export function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}

export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs: number = 2000): T {
  ensureDir(dirname(lockPath));
  const started = Date.now();

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      break;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out acquiring file lock '${lockPath}': ${String(error)}`);
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // ignore lock cleanup errors
    }
  }
}

export function listDirEntries(path: string): string[] {
  if (!dirExists(path)) return [];
  return readdirSync(path).sort();
}

export function findManifestPath(pluginDir: string): string | null {
  const candidates = [
    join(pluginDir, "plugin.json"),
    join(pluginDir, ".claude-plugin", "plugin.json"),
  ];
  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  return null;
}

export function walkMarkdownFiles(root: string, stopAtSkillDir: boolean): string[] {
  if (!dirExists(root)) return [];
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = listDirEntries(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (!stat.isDirectory()) {
        if (entry.toLowerCase().endsWith(".md")) files.push(full);
        continue;
      }
      if (stopAtSkillDir && fileExists(join(full, "SKILL.md"))) {
        files.push(join(full, "SKILL.md"));
        continue;
      }
      walk(full);
    }
  }

  try {
    walk(root);
  } catch {
    // ignore
  }

  return files.sort();
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const array = new Int32Array(buffer);
  Atomics.wait(array, 0, 0, ms);
}
