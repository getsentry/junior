import { describe, expect, it, vi } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createPublishImageTool } from "@/chat/tools/publish-image";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorArtifacts } from "@/db/schema";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);
const CONVERSATION_ID = "slack:C123:1718123456.000000";

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

function memoryDb(): JuniorSqlDatabase & {
  rows: Map<string, typeof juniorArtifacts.$inferInsert>;
} {
  const rows = new Map<string, typeof juniorArtifacts.$inferInsert>();
  const db = {
    select() {
      return {
        from(table: unknown) {
          if (table !== juniorArtifacts) throw new Error("unexpected table");
          return {
            where() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      if (table !== juniorArtifacts) {
        throw new Error("unexpected table");
      }
      return {
        values(values: typeof juniorArtifacts.$inferInsert) {
          rows.set(values.id, values);
          return {
            onConflictDoUpdate(args: {
              set: Partial<typeof juniorArtifacts.$inferInsert>;
            }) {
              const current = rows.get(values.id) ?? values;
              const next = { ...current, ...args.set };
              rows.set(next.id, next);
              return {
                returning() {
                  return Promise.resolve([
                    { ext: next.ext, id: next.id },
                  ]);
                },
              };
            },
          };
        },
      };
    },
  };
  return {
    rows,
    db: () => db as never,
    transaction: async (callback) => callback(),
    withLock: async (_name, callback) => callback(),
  };
}

describe("publishImage tool", () => {
  it("publishes a sandbox image to a conversation-owned public URL", async () => {
    const imageStorage = storage();
    const db = memoryDb();
    const tool = createPublishImageTool({
      conversationId: CONVERSATION_ID,
      db,
      publicBaseUrl: () => "https://junior.example.com",
      storage: imageStorage,
      workspace: workspace(PNG_BYTES),
    });

    const result = await tool.execute?.({ path: "chart.png" }, {});
    expect(result).toMatchObject({
      bytes: PNG_BYTES.byteLength,
      content_type: "image/png",
      public: true,
    });
    expect(result?.url).toMatch(
      /^https:\/\/junior\.example\.com\/public\/artifacts\/[0-9a-f-]{36}\.png$/,
    );
    const filename = result!.url.split("/").at(-1)!;
    expect(imageStorage.objects.has(`artifacts/${filename}`)).toBe(true);
    const row = [...db.rows.values()][0];
    expect(row).toMatchObject({
      conversationId: CONVERSATION_ID,
      deleteRequestedAt: null,
      public: true,
      storageKey: `artifacts/${filename}`,
    });
    expect(tool.description).toContain("Anyone on the internet");
    expect(tool.approvalMode).toBe("review");
  });

  it("rejects a missing file as input error", async () => {
    const tool = createPublishImageTool({
      conversationId: CONVERSATION_ID,
      db: memoryDb(),
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
      conversationId: CONVERSATION_ID,
      db: memoryDb(),
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
      conversationId: CONVERSATION_ID,
      db: memoryDb(),
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
