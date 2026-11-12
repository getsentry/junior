import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { identityAvatarUrl } from "@/chat/identities/avatar";
import { juniorIdentities } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { testViewer } from "../../../fixtures/user";
import { mswServer } from "../../../msw/server";

// Slack sends 512 pixel photos.
const PNG = await sharp({
  create: { width: 512, height: 512, channels: 3, background: "#7553ff" },
})
  .png()
  .toBuffer();
// A PNG signature without an image. sharp cannot read it.
const BROKEN_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

// Junior sends a small WebP photo, not the provider photo.
async function expectSmallPhoto(response: Response) {
  expect(response.headers.get("content-type")).toBe("image/webp");
  const photo = await sharp(
    new Uint8Array(await response.arrayBuffer()),
  ).metadata();
  expect(photo).toMatchObject({ format: "webp", width: 96, height: 96 });
}

function signedInApi() {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer("viewer@example.com"));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

function identity(id: string, avatarUrl: string, provider = "slack") {
  return {
    id,
    avatarUrl,
    createdAt: new Date(1_000),
    kind: "user" as const,
    provider,
    providerSubjectId: id,
    providerTenantId: "T1",
    updatedAt: new Date(1_000),
  };
}

describe("profile photo API", () => {
  test("serves a saved photo from Junior and fetches it only once", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const fetched: string[] = [];
    mswServer.use(
      http.get("https://avatars.slack-edge.com/:file", ({ request }) => {
        fetched.push(request.url);
        if (request.url.endsWith("/text.png")) {
          return new HttpResponse("<svg onload=alert(1)>", {
            headers: { "content-type": "image/png" },
          });
        }
        if (request.url.endsWith("/broken.png")) {
          return new HttpResponse(BROKEN_PNG);
        }
        return new HttpResponse(PNG, {
          // The bytes, not this header, set the content type.
          headers: { "content-type": "text/html" },
        });
      }),
      // Google serves each photo through a redirect to another photo host.
      http.get("https://lh3.googleusercontent.com/a/:file", ({ request }) => {
        fetched.push(request.url);
        const target = request.url.endsWith("/off-host")
          ? "https://example.com/photo.png"
          : "https://lh7-qw.googleusercontent.com/ro-a/photo";
        return new HttpResponse(null, {
          status: 302,
          headers: { location: target },
        });
      }),
      http.get("https://lh7-qw.googleusercontent.com/ro-a/photo", () => {
        return new HttpResponse(PNG);
      }),
    );
    try {
      await migrateSchema(fixture.sql);
      await fixture.sql
        .db()
        .insert(juniorIdentities)
        .values([
          identity("U-PHOTO", "https://avatars.slack-edge.com/photo.png"),
          identity("U-TEXT", "https://avatars.slack-edge.com/text.png"),
          identity("U-BROKEN", "https://avatars.slack-edge.com/broken.png"),
          identity("U-OTHER", "https://example.com/photo.png"),
          identity(
            "G-PHOTO",
            "https://lh3.googleusercontent.com/a/photo",
            "google",
          ),
          identity(
            "G-OFF-HOST",
            "https://lh3.googleusercontent.com/a/off-host",
            "google",
          ),
        ]);

      const signedOut = await createJuniorApi().request(
        "http://localhost/api/people/avatars/U-PHOTO",
      );
      expect(signedOut.status).toBe(401);

      const app = signedInApi();
      // APIs return the versioned path. The browser keeps that photo, and it
      // checks a path without the current version with the ETag.
      const versionedPath = identityAvatarUrl(
        {
          avatarUrl: "https://avatars.slack-edge.com/photo.png",
          identityId: "U-PHOTO",
          userId: null,
        },
        new Map(),
      );
      const unversioned = "/api/people/avatars/U-PHOTO";
      const responses = [];
      for (const path of [versionedPath, unversioned]) {
        const response = await app.request(`http://localhost${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        await expectSmallPhoto(response);
        responses.push(response);
      }
      expect(responses[0]!.headers.get("cache-control")).toBe(
        "private, max-age=31536000, immutable",
      );
      expect(responses[1]!.headers.get("cache-control")).toBe(
        "private, no-cache",
      );
      const etag = responses[1]!.headers.get("etag");
      expect(etag).toBe(responses[0]!.headers.get("etag"));
      const revalidated = await app.request(`http://localhost${unversioned}`, {
        headers: { "if-none-match": etag! },
      });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe("");

      const google = await app.request(
        "http://localhost/api/people/avatars/G-PHOTO",
      );
      expect(google.status).toBe(200);
      await expectSmallPhoto(google);

      // When sharp fails, Junior sends the provider photo.
      const unresized = await app.request(
        "http://localhost/api/people/avatars/U-BROKEN",
      );
      expect(unresized.status).toBe(200);
      expect(unresized.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await unresized.arrayBuffer())).toEqual(BROKEN_PNG);

      // A file that is not an image, a URL or redirect off the photo hosts,
      // and an unknown Identity all have no photo.
      for (const id of ["U-TEXT", "U-OTHER", "G-OFF-HOST", "U-MISSING"]) {
        const response = await app.request(
          `http://localhost/api/people/avatars/${id}`,
        );
        expect(response.status).toBe(404);
      }
      expect(fetched).toEqual([
        "https://avatars.slack-edge.com/photo.png",
        "https://lh3.googleusercontent.com/a/photo",
        "https://avatars.slack-edge.com/broken.png",
        "https://avatars.slack-edge.com/text.png",
        "https://lh3.googleusercontent.com/a/off-host",
      ]);
    } finally {
      await fixture.close();
    }
  });
});
