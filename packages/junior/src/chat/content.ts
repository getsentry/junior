import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const COMPILED_CONTENT_ROOT = "/__junior_content__";
export const COMPILED_APP_ROOT = `${COMPILED_CONTENT_ROOT}/app`;
export const COMPILED_NODE_MODULES_ROOT = `${COMPILED_CONTENT_ROOT}/node_modules`;

export interface RuntimeDirectoryEntry {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
}

export interface RuntimeContentFile {
  content: Buffer;
  path: string;
}

export interface RuntimePluginPackageContent {
  packageNames: string[];
  packages: {
    dir: string;
    hasSkillsDir: boolean;
    name: string;
  }[];
  manifestRoots: string[];
  skillRoots: string[];
  tracingIncludes: string[];
}

export interface JuniorCompiledContent {
  appRoot?: string;
  files: Record<string, string>;
  packageContent?: RuntimePluginPackageContent;
  skillRoots: string[];
  version: 1;
}

let compiledContent: JuniorCompiledContent | undefined;
let contentVersion = 0;

function normalizeCompiledPath(targetPath: string): string {
  return path.posix.resolve(targetPath.replace(/\\/g, "/"));
}

function isCompiledRuntimePath(targetPath: string): boolean {
  return (
    targetPath === COMPILED_CONTENT_ROOT ||
    targetPath.startsWith(`${COMPILED_CONTENT_ROOT}/`)
  );
}

function compiledFileBuffer(targetPath: string): Buffer | null {
  const normalized = normalizeCompiledPath(targetPath);
  if (!isCompiledRuntimePath(normalized)) {
    return null;
  }

  const raw = compiledContent?.files[normalized];
  return raw === undefined ? null : Buffer.from(raw, "base64");
}

function compiledPathIsDirectory(targetPath: string): boolean | null {
  if (!compiledContent) {
    return null;
  }

  const normalized = normalizeCompiledPath(targetPath);
  if (!isCompiledRuntimePath(normalized)) {
    return null;
  }

  const prefix = `${normalized}/`;
  return Object.keys(compiledContent.files).some((filePath) =>
    filePath.startsWith(prefix),
  );
}

function compiledDirectoryEntries(
  targetPath: string,
): RuntimeDirectoryEntry[] | null {
  if (!compiledContent) {
    return null;
  }

  const normalized = normalizeCompiledPath(targetPath);
  if (!isCompiledRuntimePath(normalized)) {
    return null;
  }

  const prefix = `${normalized}/`;
  const entries = new Map<string, RuntimeDirectoryEntry>();

  for (const filePath of Object.keys(compiledContent.files)) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }

    const relativePath = filePath.slice(prefix.length);
    const [name, ...rest] = relativePath.split("/");
    if (!name) {
      continue;
    }

    const existing = entries.get(name);
    if (rest.length === 0) {
      entries.set(name, {
        name,
        isFile: true,
        isDirectory: existing?.isDirectory ?? false,
      });
    } else {
      entries.set(name, {
        name,
        isFile: existing?.isFile ?? false,
        isDirectory: true,
      });
    }
  }

  return [...entries.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function compiledFilesRecursive(
  targetPath: string,
): RuntimeContentFile[] | null {
  if (!compiledContent) {
    return null;
  }

  const normalized = normalizeCompiledPath(targetPath);
  if (!isCompiledRuntimePath(normalized)) {
    return null;
  }

  const prefix = `${normalized}/`;
  return Object.entries(compiledContent.files)
    .filter(([filePath]) => filePath.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, raw]) => ({
      path: filePath,
      content: Buffer.from(raw, "base64"),
    }));
}

/** Replace the active compiled content graph, or reset to filesystem-backed discovery. */
export function setRuntimeContent(
  content: JuniorCompiledContent | undefined,
): void {
  if (compiledContent === content) {
    return;
  }

  compiledContent = content;
  contentVersion += 1;
}

/** Return a monotonic version for caches that depend on runtime content. */
export function getRuntimeContentVersion(): number {
  return contentVersion;
}

/** Return the compiled app root when Nitro provided one. */
export function getCompiledAppRoot(): string | undefined {
  return compiledContent?.appRoot;
}

/** Return compiled package content when Nitro provided it. */
export function getCompiledPluginPackageContent():
  | RuntimePluginPackageContent
  | undefined {
  return compiledContent?.packageContent;
}

/** Return compiled app-local skill roots when Nitro provided them. */
export function getCompiledSkillRoots(): string[] {
  return compiledContent?.skillRoots ?? [];
}

/** Check whether a runtime path resolves to a file in compiled content or on disk. */
export function runtimePathIsFile(targetPath: string): boolean {
  if (compiledFileBuffer(targetPath)) {
    return true;
  }

  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

/** Check whether a runtime path resolves to a directory in compiled content or on disk. */
export function runtimePathIsDirectory(targetPath: string): boolean {
  const compiledDirectory = compiledPathIsDirectory(targetPath);
  if (compiledDirectory !== null) {
    return compiledDirectory;
  }

  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

/** Read a UTF-8 runtime file from compiled content or disk. */
export function readRuntimeFileSync(targetPath: string): string | null {
  const compiled = compiledFileBuffer(targetPath);
  if (compiled) {
    return compiled.toString("utf8");
  }

  try {
    return fs.readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
}

/** Read a runtime file as bytes from compiled content or disk. */
export async function readRuntimeFileBuffer(
  targetPath: string,
): Promise<Buffer> {
  const compiled = compiledFileBuffer(targetPath);
  if (compiled) {
    return compiled;
  }

  return fsp.readFile(targetPath);
}

/** Read a UTF-8 runtime file asynchronously from compiled content or disk. */
export async function readRuntimeFile(targetPath: string): Promise<string> {
  const compiled = compiledFileBuffer(targetPath);
  if (compiled) {
    return compiled.toString("utf8");
  }

  return fsp.readFile(targetPath, "utf8");
}

/** List one runtime directory from compiled content or disk. */
export function listRuntimeDirectoryEntries(
  targetPath: string,
): RuntimeDirectoryEntry[] | null {
  const compiledEntries = compiledDirectoryEntries(targetPath);
  if (compiledEntries) {
    return compiledEntries;
  }

  try {
    return fs.readdirSync(targetPath, { withFileTypes: true }).map((entry) => {
      try {
        const stat = fs.statSync(path.join(targetPath, entry.name));
        return {
          name: entry.name,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
        };
      } catch {
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        };
      }
    });
  } catch {
    return null;
  }
}

/** List files below a runtime directory from compiled content, or return null for filesystem callers. */
export function listCompiledFilesRecursive(
  targetPath: string,
): RuntimeContentFile[] | null {
  return compiledFilesRecursive(targetPath);
}
