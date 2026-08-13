import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  publishImage,
  unpublishArtifact,
} from "@/chat/artifacts/store";
import { publicArtifactGET } from "@/handlers/artifacts";
import { juniorArtifacts } from "@/db/schema";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import { migrateSchema } from "@/chat/conversations/sql/migrations";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);
const OWNER_CONVERSATION_ID = "slack:C123:1718123456.000000";
const OTHER_CONVERSATION_ID = "slack:C999:1718123999.000000";

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

describe("public artifact route", () => {
  let fixture: LocalJuniorSqlFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  async function setup() {
    fixture = await createLocalJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    return fixture;
  }

  it("serves a published artifact only when the sql row allows it", async () => {
    const sql = await setup();
    const imageStorage = storage();
    const published = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(published.url).toBe(
      `https://junior.example.com/public/artifacts/${sha256}.png`,
    );

    const response = await publicArtifactGET({
      db: sql.sql,
      filename: `${sha256}.png`,
      storage: imageStorage,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);

    const [row] = await sql.sql
      .db()
      .select()
      .from(juniorArtifacts)
      .where(eq(juniorArtifacts.sha256, sha256));
    expect(row).toMatchObject({
      conversationId: OWNER_CONVERSATION_ID,
      deleteRequestedAt: null,
      public: true,
      storageKey: `artifacts/${sha256}.png`,
    });
  });

  it("returns no-store 404 after unpublish and restores on republish", async () => {
    const sql = await setup();
    const imageStorage = storage();
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    const filename = `${sha256}.png`;

    await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    await unpublishArtifact({
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      ref: `https://junior.example.com/public/artifacts/${filename}`,
    });

    const unpublished = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers.get("cache-control")).toBe("private, no-store");

    await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });

    const restored = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(restored.status).toBe(200);
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects unpublish from a different conversation", async () => {
    const sql = await setup();
    const imageStorage = storage();
    const sha256 = createHash("sha256").update(PNG_BYTES).digest("hex");
    const filename = `${sha256}.png`;

    await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });

    await expect(
      unpublishArtifact({
        conversationId: OTHER_CONVERSATION_ID,
        db: sql.sql,
        ref: filename,
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: expect.stringContaining("not found for this conversation"),
    });

    const response = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(response.status).toBe(200);
  });

  it("returns 404 for an invalid filename", async () => {
    const sql = await setup();
    const response = await publicArtifactGET({
      db: sql.sql,
      filename: "missing.png",
      storage: storage(),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
