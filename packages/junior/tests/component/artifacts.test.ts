import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { publishImage, unpublishArtifact } from "@/chat/artifacts/store";
import { publicArtifactGET } from "@/handlers/artifacts";
import { juniorArtifacts } from "@/db/schema";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import { migrateSchema } from "@/chat/conversations/sql/migrations";

const PNG_BYTES = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 1,
]);
const OWNER_CONVERSATION_ID = "slack:C123:1718123456.000000";
const OTHER_CONVERSATION_ID = "slack:C999:1718123999.000000";

function filenameFromUrl(url: string): string {
  return url.split("/").at(-1)!;
}

describe("public artifact route", () => {
  let fixture: LocalJuniorSqlFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  async function setup() {
    fixture = await createJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    return fixture;
  }

  it("serves a published artifact only when the sql row allows it", async () => {
    const sql = await setup();
    const imageStorage = createMemoryAttachmentStorage();
    const published = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const filename = filenameFromUrl(published.url);
    expect(published.url).toMatch(
      /^https:\/\/junior\.example\.com\/public\/artifacts\/[0-9a-f-]{36}\.png$/,
    );

    const response = await publicArtifactGET({
      db: sql.sql,
      filename,
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
      .where(eq(juniorArtifacts.conversationId, OWNER_CONVERSATION_ID));
    expect(row).toMatchObject({
      conversationId: OWNER_CONVERSATION_ID,
      deleteRequestedAt: null,
      storageKey: `artifacts/${filename}`,
      visibility: "public",
    });
  });

  it("returns no-store 404 after unpublish and restores on republish", async () => {
    const sql = await setup();
    const imageStorage = createMemoryAttachmentStorage();

    const first = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const filename = filenameFromUrl(first.url);
    await unpublishArtifact({
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      ref: first.url,
    });

    const unpublished = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers.get("cache-control")).toBe("private, no-store");

    const restoredPublish = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    expect(filenameFromUrl(restoredPublish.url)).toBe(filename);

    const restored = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(restored.status).toBe(200);
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("stops serving an expiring artifact at its expiry, and never shortens a link already out", async () => {
    const sql = await setup();
    const imageStorage = createMemoryAttachmentStorage();
    const publish = (expiresAt?: Date) =>
      publishImage({
        body: PNG_BYTES,
        conversationId: OWNER_CONVERSATION_ID,
        db: sql.sql,
        ...(expiresAt ? { expiresAt } : undefined),
        publicBaseUrl: "https://junior.example.com",
        storage: imageStorage,
      });
    const inMinutes = (minutes: number) =>
      new Date(Date.now() + minutes * 60_000);

    const brief = await publish(inMinutes(2));
    const filename = filenameFromUrl(brief.url);
    const live = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(live.status).toBe(200);
    // No cache may serve the artifact past its expiry.
    const maxAge = Number(
      live.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1],
    );
    expect(maxAge).toBeGreaterThan(100);
    expect(maxAge).toBeLessThanOrEqual(120);

    // Publishing the same bytes again keeps the later expiry, and no expiry
    // beats both.
    expect((await publish(inMinutes(1))).expiresAt).toEqual(brief.expiresAt);
    const permanent = await publish();
    expect(filenameFromUrl(permanent.url)).toBe(filename);
    expect(permanent.expiresAt).toBeNull();
    expect((await publish(inMinutes(1))).expiresAt).toBeNull();

    // An expired artifact takes the new expiry when published again.
    await sql.sql
      .db()
      .update(juniorArtifacts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(juniorArtifacts.conversationId, OWNER_CONVERSATION_ID));
    const expired = await publicArtifactGET({
      db: sql.sql,
      filename,
      storage: imageStorage,
    });
    expect(expired.status).toBe(404);
    expect(expired.headers.get("cache-control")).toBe("private, no-store");
    const renewed = await publish(inMinutes(1));
    expect(renewed.expiresAt!.getTime()).toBeLessThanOrEqual(
      inMinutes(1).getTime(),
    );
    expect(
      (
        await publicArtifactGET({
          db: sql.sql,
          filename,
          storage: imageStorage,
        })
      ).status,
    ).toBe(200);
  });

  it("rejects unpublish from a different conversation", async () => {
    const sql = await setup();
    const imageStorage = createMemoryAttachmentStorage();
    const published = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const filename = filenameFromUrl(published.url);

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

  it("gives each conversation its own artifact for the same bytes", async () => {
    const sql = await setup();
    const imageStorage = createMemoryAttachmentStorage();

    const owner = await publishImage({
      body: PNG_BYTES,
      conversationId: OWNER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });
    const other = await publishImage({
      body: PNG_BYTES,
      conversationId: OTHER_CONVERSATION_ID,
      db: sql.sql,
      publicBaseUrl: "https://junior.example.com",
      storage: imageStorage,
    });

    const ownerFilename = filenameFromUrl(owner.url);
    const otherFilename = filenameFromUrl(other.url);
    expect(ownerFilename).not.toBe(otherFilename);

    await unpublishArtifact({
      conversationId: OTHER_CONVERSATION_ID,
      db: sql.sql,
      ref: other.url,
    });

    const ownerResponse = await publicArtifactGET({
      db: sql.sql,
      filename: ownerFilename,
      storage: imageStorage,
    });
    const otherResponse = await publicArtifactGET({
      db: sql.sql,
      filename: otherFilename,
      storage: imageStorage,
    });
    expect(ownerResponse.status).toBe(200);
    expect(otherResponse.status).toBe(404);
  });

  it("returns 404 for an invalid filename", async () => {
    const sql = await setup();
    const response = await publicArtifactGET({
      db: sql.sql,
      filename: "missing.png",
      storage: createMemoryAttachmentStorage(),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
