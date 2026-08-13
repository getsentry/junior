import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createPublishImageTool } from "@/chat/tools/publish-image";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);

function workspace(data: Buffer | null): SandboxWorkspace {
  return {
    readFileToBuffer: vi.fn(async () => data),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    })),
    writeFiles: vi.fn(async () => {}),
  };
}

function storage(): AttachmentStorage & {
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    provider: "test",
    async put(input) {
      objects.set(input.key, Buffer.from(input.body));
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
}

describe("publishImage tool", () => {
  it("publishes a sandbox image to a public URL", async () => {
    const imageStorage = storage();
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      storage: imageStorage,
      workspace: workspace(PNG_BYTES),
    });

    const result = await tool.execute?.({ path: "chart.png" }, {});
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(result).toEqual({
      bytes: PNG_BYTES.byteLength,
      content_type: "image/png",
      public: true,
      url: `https://junior.example.com/public/images/${sha256}.png`,
    });
    expect(imageStorage.objects.has(`published-images/${sha256}.png`)).toBe(
      true,
    );
    expect(tool.description).toContain("Anyone on the internet");
    expect(tool.approvalMode).toBe("review");
  });

  it("rejects a missing file as input error", async () => {
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      storage: storage(),
      workspace: workspace(null),
    });

    await expect(
      tool.execute?.({ path: "missing.png" }, {}),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining("failed to read file"),
    });
  });

  it("rejects unsupported image bytes as input error", async () => {
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      storage: storage(),
      workspace: workspace(Buffer.from("not-an-image")),
    });

    await expect(tool.execute?.({ path: "notes.txt" }, {})).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining("unsupported image format"),
    });
  });

  it("keeps storage outages as system errors", async () => {
    const imageStorage = storage();
    imageStorage.put = vi.fn(async () => {
      throw new Error("blob unavailable");
    });
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      storage: imageStorage,
      workspace: workspace(PNG_BYTES),
    });

    await expect(tool.execute?.({ path: "chart.png" }, {})).rejects.toMatchObject({
      name: "Error",
      message: "blob unavailable",
    });
  });
});
