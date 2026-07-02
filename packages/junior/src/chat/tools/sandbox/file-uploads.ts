import path from "node:path";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

/** Maximum single file size accepted by model-facing upload tools. */
export const MAX_SANDBOX_FILE_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Sandbox directory for generated files that later tools can consume. */
export const SANDBOX_ARTIFACTS_DIR = "/tmp/junior/artifacts";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
};

/** Materialized sandbox file data ready for outbound upload boundaries. */
export interface SandboxFileUpload {
  bytes: number;
  data: Buffer;
  filename: string;
  mimeType: string;
  path: string;
}

/** Signal that a model-provided file path did not resolve in the active sandbox. */
export class SandboxFileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`failed to read file: ${path}`);
  }
}

/** Resolve model-provided sandbox paths against the sandbox workspace root. */
export function normalizeSandboxPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error("path is required");
  }

  if (path.posix.isAbsolute(trimmed)) {
    return trimmed;
  }

  return path.posix.join(SANDBOX_WORKSPACE_ROOT, trimmed);
}

function sanitizeFilename(
  value: string | undefined,
  fallbackPath: string,
): string {
  const candidate = (value ?? "").trim();
  if (candidate) {
    const base = path.posix.basename(candidate);
    if (base && base !== "." && base !== "..") {
      return base;
    }
  }

  const derived = path.posix.basename(fallbackPath);
  if (derived && derived !== "." && derived !== "..") {
    return derived;
  }

  return "attachment.bin";
}

/** Return the canonical sandbox artifact path for generated files. */
export function sandboxArtifactPath(filename: string): string {
  return path.posix.join(
    SANDBOX_ARTIFACTS_DIR,
    sanitizeFilename(filename, "artifact.bin"),
  );
}

/** Infer upload MIME type from an explicit value or filename extension. */
export function inferMimeType(
  filename: string,
  explicitMimeType?: string,
): string {
  const explicit = explicitMimeType?.trim();
  if (explicit) {
    return explicit;
  }

  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

async function detectMimeType(
  sandbox: SandboxWorkspace,
  targetPath: string,
): Promise<string | undefined> {
  try {
    const result = await runNonInteractiveCommand(sandbox, {
      cmd: "file",
      args: ["--mime-type", "-b", targetPath],
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const value = (await result.stdout()).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Read and validate one sandbox file for Slack/file reply upload. */
export async function readSandboxFileUpload(
  sandbox: SandboxWorkspace,
  input: {
    path: string;
    filename?: string;
    mimeType?: string;
  },
): Promise<SandboxFileUpload> {
  const targetPath = normalizeSandboxPath(input.path);
  const fileBuffer = await sandbox.readFileToBuffer({ path: targetPath });
  if (!fileBuffer) {
    throw new SandboxFileNotFoundError(targetPath);
  }

  if (fileBuffer.byteLength === 0) {
    throw new Error(`file is empty: ${targetPath}`);
  }

  if (fileBuffer.byteLength > MAX_SANDBOX_FILE_UPLOAD_BYTES) {
    throw new Error(
      `file exceeds ${MAX_SANDBOX_FILE_UPLOAD_BYTES} bytes: ${targetPath} (${fileBuffer.byteLength} bytes)`,
    );
  }

  const resolvedFilename = sanitizeFilename(input.filename, targetPath);
  const detectedMimeType = await detectMimeType(sandbox, targetPath);
  const resolvedMimeType = inferMimeType(
    resolvedFilename,
    input.mimeType ?? detectedMimeType,
  );

  return {
    bytes: fileBuffer.byteLength,
    data: fileBuffer,
    filename: resolvedFilename,
    mimeType: resolvedMimeType,
    path: targetPath,
  };
}
