import path from "node:path";
import type { FileUpload } from "chat";
import { Type } from "@sinclair/typebox";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { tool } from "@/chat/tools/definition";
import type { ToolHooks } from "@/chat/tools/types";

const MAX_ATTACH_FILE_BYTES = 10 * 1024 * 1024;

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

function normalizeSandboxPath(inputPath: string): string {
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

function inferMimeType(filename: string, explicitMimeType?: string): string {
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
    const result = await sandbox.runCommand({
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

export function createAttachFileTool(
  sandbox: SandboxWorkspace,
  hooks: ToolHooks = {},
) {
  return tool({
    description:
      "Attach a file to the Slack reply. Use this for files that exist in the sandbox, such as screenshots, PDFs, or logs, or for generated image `attachment_path` values returned earlier in the turn.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description:
            "Absolute path (for example /tmp/screenshot.png) or workspace-relative path.",
        }),
        filename: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional filename override shown in Slack.",
          }),
        ),
        mimeType: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional MIME type override (for example image/png).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ path: requestedPath, filename, mimeType }) => {
      const targetPath = normalizeSandboxPath(requestedPath);
      const fileBuffer = await sandbox.readFileToBuffer({ path: targetPath });
      if (!fileBuffer) {
        const generatedFile = hooks.getGeneratedFile?.(
          path.posix.basename(targetPath),
        );
        if (generatedFile) {
          hooks.onGeneratedFiles?.([generatedFile]);
          return {
            ok: true,
            attached: true,
            path: targetPath,
            filename: generatedFile.filename,
            mime_type:
              generatedFile.mimeType ?? inferMimeType(generatedFile.filename),
            bytes: Buffer.isBuffer(generatedFile.data)
              ? generatedFile.data.byteLength
              : generatedFile.data instanceof ArrayBuffer
                ? generatedFile.data.byteLength
                : generatedFile.data.size,
          };
        }

        throw new Error(`failed to read file: ${targetPath}`);
      }

      if (fileBuffer.byteLength === 0) {
        throw new Error(`file is empty: ${targetPath}`);
      }

      if (fileBuffer.byteLength > MAX_ATTACH_FILE_BYTES) {
        throw new Error(
          `file exceeds ${MAX_ATTACH_FILE_BYTES} bytes: ${targetPath} (${fileBuffer.byteLength} bytes)`,
        );
      }

      const resolvedFilename = sanitizeFilename(filename, targetPath);
      const detectedMimeType = await detectMimeType(sandbox, targetPath);
      const resolvedMimeType = inferMimeType(
        resolvedFilename,
        mimeType ?? detectedMimeType,
      );
      const upload: FileUpload = {
        data: fileBuffer,
        filename: resolvedFilename,
        mimeType: resolvedMimeType,
      };
      hooks.onGeneratedFiles?.([upload]);

      return {
        ok: true,
        attached: true,
        path: targetPath,
        filename: resolvedFilename,
        mime_type: resolvedMimeType,
        bytes: fileBuffer.byteLength,
      };
    },
  });
}
