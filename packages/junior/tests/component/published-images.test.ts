import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { publishImage } from "@/chat/published-images/store";
import { publishedImageGET } from "@/handlers/published-images";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);

function storage(): AttachmentStorage {
  const objects = new Map<string, Buffer>();
  return {
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

describe("published image route", () => {
  it("serves a published image without authentication", async () => {
    const imageStorage = storage();
    await publishImage({
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");

    const response = await publishedImageGET({
      filename: `${sha256}.png`,
      storage: imageStorage,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("returns 404 for an invalid filename", async () => {
    const response = await publishedImageGET({
      filename: "missing.png",
      storage: storage(),
    });
    expect(response.status).toBe(404);
  });
});
