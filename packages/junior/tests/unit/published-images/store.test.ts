import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PublishedImageStorage } from "@/chat/published-images/storage";
import {
  parsePublishedImagePath,
  publishImage,
  publishedImageMarkdown,
  publishedImageUrl,
  readPublishedImage,
} from "@/chat/published-images/store";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);

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

describe("published image store", () => {
  it("publishes content-addressed public image urls", async () => {
    const storage = memoryStorage();
    const published = await publishImage({
      alt: "chart",
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com/",
      storage,
    });

    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(published).toEqual({
      bytes: PNG_BYTES.byteLength,
      contentType: "image/png",
      markdown: `![chart](https://junior.example.com/public/images/${sha256}.png)`,
      storageKey: `published-images/${sha256}.png`,
      url: `https://junior.example.com/public/images/${sha256}.png`,
    });
    expect(storage.objects.get(published.storageKey)?.contentType).toBe(
      "image/png",
    );
  });

  it("reuses the same key for identical bytes", async () => {
    const storage = memoryStorage();
    const first = await publishImage({
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com",
      storage,
    });
    const second = await publishImage({
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com",
      storage,
    });
    expect(second.storageKey).toBe(first.storageKey);
    expect(second.url).toBe(first.url);
    expect(storage.objects.size).toBe(1);
  });

  it("rejects empty, oversized, and unsupported files", async () => {
    const storage = memoryStorage();
    await expect(
      publishImage({
        body: Buffer.alloc(0),
        publicBaseUrl: "https://junior.example.com",
        storage,
      }),
    ).rejects.toThrow("image is empty");
    await expect(
      publishImage({
        body: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
        publicBaseUrl: "https://junior.example.com",
        storage,
      }),
    ).rejects.toThrow("image exceeds");
    await expect(
      publishImage({
        body: Buffer.from("not an image"),
        publicBaseUrl: "https://junior.example.com",
        storage,
      }),
    ).rejects.toThrow("unsupported image format");
  });

  it("reads published images and rejects path mismatches", async () => {
    const storage = memoryStorage();
    const published = await publishImage({
      body: PNG_BYTES,
      publicBaseUrl: "https://junior.example.com",
      storage,
    });
    const sha256 = published.storageKey
      .replace("published-images/", "")
      .replace(".png", "");

    const image = await readPublishedImage({
      extension: "png",
      sha256,
      storage,
    });
    expect(image?.contentType).toBe("image/png");
    expect(image?.bytes).toBe(PNG_BYTES.byteLength);

    expect(
      await readPublishedImage({
        extension: "jpg",
        sha256,
        storage,
      }),
    ).toBeNull();
    expect(parsePublishedImagePath({ extension: "png", sha256: "nope" })).toBe(
      null,
    );
    expect(
      publishedImageUrl({
        extension: "png",
        publicBaseUrl: "https://junior.example.com",
        sha256,
      }),
    ).toBe(published.url);
    expect(publishedImageMarkdown({ alt: "a [b]", url: published.url })).toBe(
      `![a b](${published.url})`,
    );
  });
});
