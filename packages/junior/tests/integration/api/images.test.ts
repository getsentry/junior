import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { githubPlugin } from "@sentry/junior-github";
import {
  defineJuniorPlugin,
  encodeObjectImageRef,
  type User,
} from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { identityAvatarUrl } from "@/chat/identities/avatar";
import { MAX_IMAGE_BYTES } from "@/chat/images/fetch";
import { imagePath, type ImageRef } from "@/chat/images/ids";
import { juniorIdentities } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#7553ff" },
  })
    .png()
    .toBuffer();
}

// Slack sends 512 pixel photos.
const PHOTO = await png(512, 512);
const LARGE = await png(2400, 1500);
// A PNG signature without an image. sharp cannot read it.
const BROKEN_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function signedInApi(viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

function requestImage(
  path: string,
  viewer: string | User = "viewer@example.com",
): Promise<Response> | Response {
  return signedInApi(
    typeof viewer === "string" ? testViewer(viewer) : viewer,
  ).request(`http://localhost${path}`);
}

// A viewer whose linked GitHub account is `login`.
function gitHubViewer(login: string): User {
  return {
    ...testViewer(`${login}@example.com`),
    identities: [
      {
        handle: login,
        id: `github:${login}`,
        provider: "github",
        providerSubjectId: login,
      },
    ],
  };
}

function publicImage(url: string, width: 128 | 320 | 1280 = 320) {
  return imagePath({ ref: url, source: "public" }, width);
}

async function expectWebp(
  response: Response,
  size: { height: number; width: number },
) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/webp");
  const image = await sharp(
    new Uint8Array(await response.arrayBuffer()),
  ).metadata();
  expect(image).toMatchObject({ format: "webp", ...size });
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

describe("image API", () => {
  test("serves profile photos at their People path as WebP and fetches each one once", async () => {
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
        return new HttpResponse(PHOTO, {
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
        return new HttpResponse(PHOTO);
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
      // Photos keep their stable People path, so saved photo URLs work.
      const avatar = (identityId: string) =>
        `/api/people/avatars/${encodeURIComponent(identityId)}`;

      const signedOut = await createJuniorApi().request(
        `http://localhost${avatar("U-PHOTO")}`,
      );
      expect(signedOut.status).toBe(401);

      // APIs return the versioned path, and the browser keeps that photo.
      const versionedPath = identityAvatarUrl(
        {
          avatarUrl: "https://avatars.slack-edge.com/photo.png",
          identityId: "U-PHOTO",
          userId: null,
        },
        new Map(),
      );
      expect(versionedPath).toMatch(/^\/api\/people\/avatars\/U-PHOTO\?v=/);
      const versioned = await requestImage(versionedPath!);
      expect(versioned.headers.get("cache-control")).toBe(
        "private, max-age=31536000, immutable",
      );
      expect(versioned.headers.get("x-content-type-options")).toBe("nosniff");
      await expectWebp(versioned, { height: 128, width: 128 });
      const unversioned = await requestImage(avatar("U-PHOTO"));
      expect(unversioned.headers.get("cache-control")).toBe(
        "private, max-age=86400",
      );
      await expectWebp(unversioned, { height: 128, width: 128 });

      await expectWebp(await requestImage(avatar("G-PHOTO")), {
        height: 128,
        width: 128,
      });

      // When sharp fails, Junior sends the fetched photo.
      const unresized = await requestImage(avatar("U-BROKEN"));
      expect(unresized.status).toBe(200);
      expect(unresized.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await unresized.arrayBuffer())).toEqual(BROKEN_PNG);

      // A file that is not an image, a URL or redirect off the photo hosts,
      // and an unknown Identity all have no photo.
      for (const id of ["U-TEXT", "U-OTHER", "G-OFF-HOST", "U-MISSING"]) {
        expect((await requestImage(avatar(id))).status).toBe(404);
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

  test("scales an image to the asked width as WebP and never makes it larger", async () => {
    mswServer.use(
      http.get(
        "https://images.example.com/large.png",
        () =>
          new HttpResponse(new Uint8Array(LARGE), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const url = "https://images.example.com/large.png";
    await expectWebp(await requestImage(publicImage(url, 320)), {
      height: 200,
      width: 320,
    });
    await expectWebp(await requestImage(publicImage(url, 1280)), {
      height: 800,
      width: 1280,
    });

    mswServer.use(
      http.get(
        "https://images.example.com/small.png",
        async () => new HttpResponse(new Uint8Array(await png(200, 100))),
      ),
    );
    await expectWebp(
      await requestImage(publicImage("https://images.example.com/small.png")),
      { height: 100, width: 200 },
    );
  });

  test("rejects an unknown width and a changed id", async () => {
    let fetches = 0;
    mswServer.use(
      http.get("https://images.example.com/photo.png", () => {
        fetches += 1;
        return new HttpResponse(new Uint8Array(PHOTO));
      }),
    );
    const path = publicImage("https://images.example.com/photo.png");
    expect((await requestImage(path.replace("w=320", "w=100"))).status).toBe(
      400,
    );

    // A browser cannot name another image: the signature covers the id.
    const [id] = path.slice("/api/images/".length).split("?");
    const [payload, signature] = id!.split(".");
    const other = Buffer.from(
      JSON.stringify({
        ref: "https://images.example.com/other.png",
        source: "public",
      } satisfies ImageRef),
    ).toString("base64url");
    for (const tampered of [
      `${other}.${signature}`,
      `${payload}.${signature!.slice(0, -2)}AA`,
      payload!,
    ]) {
      expect((await requestImage(`/api/images/${tampered}?w=320`)).status).toBe(
        404,
      );
    }
    expect(fetches).toBe(0);
  });

  test("fetches no private address, no plain http, and not after a redirect either", async () => {
    // Count connections, not requests: a TLS hello to this server is no
    // request, but it still reaches the private address.
    let privateHits = 0;
    const server = createServer();
    server.on("connection", () => {
      privateHits += 1;
    });
    let plainHits = 0;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    mswServer.use(
      http.get("https://images.example.com/redirect.png", () =>
        HttpResponse.redirect(`https://127.0.0.1:${port}/photo.png`, 302),
      ),
      http.get("http://images.example.com/plain.png", () => {
        plainHits += 1;
        return new HttpResponse(PHOTO, {
          headers: { "content-type": "image/png" },
        });
      }),
    );
    try {
      for (const url of [
        `https://127.0.0.1:${port}/photo.png`,
        `https://localhost:${port}/photo.png`,
        `https://[::1]:${port}/photo.png`,
        "https://images.example.com/redirect.png",
        "http://images.example.com/plain.png",
      ]) {
        expect((await requestImage(publicImage(url))).status).toBe(404);
      }
      expect(privateHits).toBe(0);
      expect(plainHits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("serves no file that is not an image, is too large, or redirects to a bad URL", async () => {
    const tooLarge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    tooLarge.set(PHOTO.subarray(0, 8));
    mswServer.use(
      http.get("https://images.example.com/page.png", () =>
        HttpResponse.html("<html><body>not an image</body></html>"),
      ),
      http.get(
        "https://images.example.com/bad-redirect.png",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "http://[not-a-host" },
          }),
      ),
      http.get(
        "https://images.example.com/huge.png",
        () =>
          new HttpResponse(new Uint8Array(tooLarge), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    for (const url of [
      "https://images.example.com/page.png",
      "https://images.example.com/huge.png",
      "https://images.example.com/bad-redirect.png",
    ]) {
      expect((await requestImage(publicImage(url))).status).toBe(404);
    }
  });

  test("lets a plugin source check each viewer and fetch with its own credential", async () => {
    const authorization: (string | null)[] = [];
    mswServer.use(
      http.get(
        "https://code.example.com/avatars/octocat.png",
        ({ request }) => {
          const header = request.headers.get("authorization");
          authorization.push(header);
          return header
            ? new HttpResponse(new Uint8Array(PHOTO))
            : new HttpResponse(null, { status: 403 });
        },
      ),
    );
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "code-host",
            displayName: "Code host",
            description: "Code host test images",
          },
          images: {
            resolve: async (ctx, ref) =>
              ctx.viewer.email === "member@example.com"
                ? {
                    headers: { authorization: "Bearer plugin-token" },
                    url: `https://code.example.com/avatars/${ref}.png`,
                  }
                : undefined,
          },
        }),
      ]),
    });
    const path = imagePath({ ref: "octocat", source: "code-host" }, 64);

    await expectWebp(await requestImage(path, "member@example.com"), {
      height: 64,
      width: 64,
    });
    expect(authorization).toEqual(["Bearer plugin-token"]);
    // The cached image does not reach a viewer that the source turns away.
    expect((await requestImage(path, "outsider@example.com")).status).toBe(404);
    // A public id for the same URL fetches without the credential, so it
    // does not get the cached private image.
    const publicPath = imagePath(
      { ref: "https://code.example.com/avatars/octocat.png", source: "public" },
      64,
    );
    expect(
      (await requestImage(publicPath, "outsider@example.com")).status,
    ).toBe(404);
    expect(authorization).toEqual(["Bearer plugin-token", null]);
    expect(
      (
        await requestImage(
          imagePath({ ref: "octocat", source: "unknown" }, 64),
          "member@example.com",
        )
      ).status,
    ).toBe(404);
  });

  test("serves a GitHub description image only to viewers who can see the repository", async () => {
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ format: "pem", type: "pkcs1" })
        .toString(),
    );
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    const signed =
      "https://private-user-images.githubusercontent.com/1/2.png?jwt=signed";
    const attachmentReads: (string | null)[] = [];
    const signedReads: (string | null)[] = [];
    let memberChecks = 0;
    mswServer.use(
      http.get("https://api.github.com/app/installations/456", () =>
        HttpResponse.json({
          permissions: { contents: "read", metadata: "read" },
        }),
      ),
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            token: "app-token",
          }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/secret/collaborators/:login/permission",
        ({ params }) => {
          if (params.login !== "member") {
            return HttpResponse.json({ permission: "none" });
          }
          // The first read of the member's access fails for a short time.
          memberChecks += 1;
          return memberChecks === 1
            ? HttpResponse.json({ message: "rate limited" }, { status: 502 })
            : HttpResponse.json({ permission: "read" });
        },
      ),
      // GitHub redirects a private attachment to a short-lived signed URL.
      http.get(attachment, ({ request }) => {
        attachmentReads.push(request.headers.get("authorization"));
        return request.headers.get("authorization")
          ? new HttpResponse(null, {
              headers: { location: signed },
              status: 302,
            })
          : new HttpResponse(null, { status: 404 });
      }),
      http.get(
        "https://private-user-images.githubusercontent.com/1/2.png",
        ({ request }) => {
          signedReads.push(request.headers.get("authorization"));
          return new HttpResponse(new Uint8Array(LARGE));
        },
      ),
    );
    try {
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      const image = {
        ref: encodeObjectImageRef({
          key: "getsentry/secret#7",
          url: attachment,
        }),
        source: "github",
      };

      // Nothing is fetched with the App credential for a viewer who cannot
      // see the repository, or who has no linked GitHub account.
      for (const viewer of [gitHubViewer("outsider"), "nobody@example.com"]) {
        expect((await requestImage(imagePath(image, 320), viewer)).status).toBe(
          404,
        );
      }
      expect(attachmentReads).toEqual([]);
      expect(signedReads).toEqual([]);

      // A failed access read is not an answer, so it is not kept as a denial.
      expect(
        (await requestImage(imagePath(image, 640), gitHubViewer("member")))
          .status,
      ).not.toBe(200);
      expect(attachmentReads).toEqual([]);
      await expectWebp(
        await requestImage(imagePath(image, 640), gitHubViewer("member")),
        { height: 400, width: 640 },
      );
      expect(attachmentReads).toHaveLength(1);
      // Egress sends the App token to github.com as Basic auth.
      const [, credential = ""] = attachmentReads[0]?.split(" ") ?? [];
      expect(Buffer.from(credential, "base64").toString()).toContain(
        "app-token",
      );
      // The credential stays on github.com.
      expect(signedReads).toEqual([null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
