import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publishImage } from "@/chat/published-images/store";
import type { PublishedImageStorage } from "@/chat/published-images/storage";
import { publishedImageGET } from "@/handlers/published-images";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);

function memoryStorage(): PublishedImageStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
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

describe("published image public route", () => {
  it("serves published images without authentication", async () => {
    const storage = memoryStorage();
    await publishImage({
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com",
      storage,
    });
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");

    const response = await publishedImageGET(new Request("https://example.com"), {
      extension: "png",
      sha256,
      storage,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("public");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("returns 404 for unknown images", async () => {
    const response = await publishedImageGET(new Request("https://example.com"), {
      extension: "png",
      sha256: "a".repeat(64),
      storage: memoryStorage(),
    });
    expect(response.status).toBe(404);
  });
});
