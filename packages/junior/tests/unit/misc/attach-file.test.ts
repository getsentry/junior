import { describe, expect, it, vi } from "vitest";
import type { FileUpload } from "chat";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createAttachFileTool } from "@/chat/tools/sandbox/attach-file";

function getUploadBytes(data: FileUpload["data"]): number {
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.size;
}

function makeSandbox(overrides?: {
  readFileToBuffer?: (params: { path: string }) => Promise<Buffer | null>;
  runCommand?: (params: { cmd: string; args?: string[] }) => Promise<{
    exitCode: number;
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
  }>;
}) {
  return {
    readFileToBuffer:
      overrides?.readFileToBuffer ?? (async () => Buffer.from("png-bytes")),
    runCommand:
      overrides?.runCommand ??
      (async () => ({
        exitCode: 0,
        stdout: async () => "image/png\n",
        stderr: async () => "",
      })),
  } satisfies SandboxWorkspace;
}

describe("createAttachFileTool", () => {
  it("attaches a sandbox file and emits upload metadata", async () => {
    const uploads: Array<{
      filename: string;
      mimeType?: string;
      bytes: number;
    }> = [];
    const tool = createAttachFileTool(makeSandbox(), {
      onGeneratedFiles: (files: FileUpload[]) => {
        uploads.push(
          ...files.map((file: FileUpload) => ({
            filename: file.filename,
            mimeType: file.mimeType,
            bytes: getUploadBytes(file.data),
          })),
        );
      },
    } as any);
    if (typeof tool.execute !== "function") {
      throw new Error("attachFile execute function missing");
    }

    const result = await tool.execute(
      { path: "/tmp/sentry-home.png" },
      {} as any,
    );

    expect(result).toMatchObject({
      ok: true,
      attached: true,
      path: "/tmp/sentry-home.png",
      filename: "sentry-home.png",
      mime_type: "image/png",
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      filename: "sentry-home.png",
      mimeType: "image/png",
      bytes: Buffer.from("png-bytes").byteLength,
    });
  });

  it("errors when file does not exist", async () => {
    const sandbox = makeSandbox({
      readFileToBuffer: async () => null,
    });
    const tool = createAttachFileTool(sandbox);
    if (typeof tool.execute !== "function") {
      throw new Error("attachFile execute function missing");
    }

    await expect(
      tool.execute({ path: "/tmp/missing.png" }, {} as any),
    ).rejects.toThrow("failed to read file: /tmp/missing.png");
  });

  it("treats same-turn generated images as already attached when the sandbox file is missing", async () => {
    const sandbox = makeSandbox({
      readFileToBuffer: async () => null,
    });
    const uploads: Array<{ filename: string; bytes: number }> = [];
    const tool = createAttachFileTool(sandbox, {
      getGeneratedFile: () => ({
        data: Buffer.from("generated-bytes"),
        filename: "generated-image-1.png",
        mimeType: "image/png",
      }),
      onGeneratedFiles: (files: FileUpload[]) => {
        uploads.push(
          ...files.map((file) => ({
            filename: file.filename,
            bytes: getUploadBytes(file.data),
          })),
        );
      },
    });
    if (typeof tool.execute !== "function") {
      throw new Error("attachFile execute function missing");
    }

    const result = await tool.execute(
      { path: "/vercel/sandbox/generated-image-1.png" },
      {} as any,
    );

    expect(result).toMatchObject({
      ok: true,
      attached: true,
      filename: "generated-image-1.png",
      mime_type: "image/png",
      bytes: Buffer.from("generated-bytes").byteLength,
    });
    expect(uploads).toEqual([
      {
        filename: "generated-image-1.png",
        bytes: Buffer.from("generated-bytes").byteLength,
      },
    ]);
  });

  it("errors when file exceeds max size", async () => {
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const sandbox = makeSandbox({
      readFileToBuffer: async () => tooLarge,
    });
    const tool = createAttachFileTool(sandbox);
    if (typeof tool.execute !== "function") {
      throw new Error("attachFile execute function missing");
    }

    await expect(
      tool.execute({ path: "/tmp/huge.png" }, {} as any),
    ).rejects.toThrow("file exceeds 10485760 bytes");
  });

  it("falls back to extension mime when file command is unavailable", async () => {
    const sandbox = makeSandbox({
      runCommand: async () => ({
        exitCode: 1,
        stdout: async () => "",
        stderr: async () => "file: command not found",
      }),
    });
    const tool = createAttachFileTool(sandbox);
    if (typeof tool.execute !== "function") {
      throw new Error("attachFile execute function missing");
    }

    const result = await tool.execute({ path: "/tmp/report.pdf" }, {} as any);
    expect(result).toMatchObject({
      ok: true,
      mime_type: "application/pdf",
    });
  });
});
