import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createPublishImageTool } from "@/chat/tools/publish-image";
import type { PublishedImageStorage } from "@/chat/published-images/storage";
import type { ToolState } from "@/chat/tools/types";

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

function memoryStorage(): PublishedImageStorage & {
  objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    provider: "test",
    async put(input) {
      objects.set(input.key, {
        body: Buffer.from(input.body),
        contentType: input.contentType,
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.body);
          controller.close();
        },
      });
    },
  };
}

function toolState(): ToolState {
  const cache = new Map<string, unknown>();
  return {
    getOperationResult: <T>(key: string) => cache.get(key) as T | undefined,
    setOperationResult: (key, value) => {
      cache.set(key, value);
    },
  };
}

describe("publishImage tool", () => {
  it("publishes a sandbox image to a public url and markdown", async () => {
    const storage = memoryStorage();
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      state: toolState(),
      storage,
      workspace: workspace(PNG_BYTES),
    });

    const result = await tool.execute?.({ path: "chart.png", alt: "chart" }, {});
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(result).toEqual({
      bytes: PNG_BYTES.byteLength,
      content_type: "image/png",
      markdown: `![chart](https://junior.example.com/public/images/${sha256}.png)`,
      public: true,
      url: `https://junior.example.com/public/images/${sha256}.png`,
    });
    expect(tool.description).toContain("public to anyone on the internet");
    expect(tool.approvalMode).toBe("review");
  });

  it("deduplicates identical publishes in one turn", async () => {
    const storage = memoryStorage();
    const put = vi.fn(storage.put.bind(storage));
    storage.put = put;
    const tool = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      state: toolState(),
      storage,
      workspace: workspace(PNG_BYTES),
    });

    const first = await tool.execute?.({ path: "chart.png" }, {});
    const second = await tool.execute?.({ path: "chart.png" }, {});
    expect(second).toMatchObject({
      deduplicated: true,
      url: first?.url,
    });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("requires a public base url and a real image file", async () => {
    const storage = memoryStorage();
    const missingBase = createPublishImageTool({
      publicBaseUrl: () => undefined,
      state: toolState(),
      storage,
      workspace: workspace(PNG_BYTES),
    });
    await expect(
      missingBase.execute?.({ path: "chart.png" }, {}),
    ).rejects.toThrow("JUNIOR_BASE_URL");

    const missingFile = createPublishImageTool({
      publicBaseUrl: () => "https://junior.example.com",
      state: toolState(),
      storage,
      workspace: workspace(null),
    });
    await expect(
      missingFile.execute?.({ path: "missing.png" }, {}),
    ).rejects.toThrow("failed to read file");
  });
});
