import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { describe, expect, test } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { juniorIdentities } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { testViewer } from "../../../fixtures/user";
import { mswServer } from "../../../msw/server";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

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
      for (let request = 0; request < 2; request += 1) {
        const response = await app.request(
          "http://localhost/api/people/avatars/U-PHOTO",
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
      }

      const google = await app.request(
        "http://localhost/api/people/avatars/G-PHOTO",
      );
      expect(google.status).toBe(200);
      expect(new Uint8Array(await google.arrayBuffer())).toEqual(PNG);

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
        "https://avatars.slack-edge.com/text.png",
        "https://lh3.googleusercontent.com/a/off-host",
      ]);
    } finally {
      await fixture.close();
    }
  });
});
