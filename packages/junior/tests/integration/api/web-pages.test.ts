import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { MAX_WEB_PAGE_BYTES } from "@/api/objects/web-page/resolve";
import { objectLinksReportSchema } from "@/api/schema";
import { createApp, defineJuniorPlugins } from "@/app";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { decodeImageId } from "@/chat/images/ids";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const COVER = await sharp({
  create: { width: 1200, height: 630, channels: 3, background: "#7553ff" },
})
  .png()
  .toBuffer();

function signedInApi(email = "viewer@example.com") {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function resolveLinks(urls: string[], email?: string) {
  const query = new URLSearchParams(urls.map((url) => ["url", url]));
  const response = await signedInApi(email).request(
    `http://localhost/api/objects?${query}`,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  return {
    body,
    objects: new Map(
      objectLinksReportSchema
        .parse(JSON.parse(body))
        .objects.map((item) => [item.url, item.object]),
    ),
  };
}

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><meta property="og:title" content="Body tag"></body></html>`;
}

describe("web page cards", () => {
  test("reads the plain oEmbed fields of a known provider and never its html", async () => {
    const asked: string[] = [];
    mswServer.use(
      http.get("https://www.youtube.com/oembed", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("url") ?? "");
        return HttpResponse.json({
          type: "video",
          version: "1.0",
          title: "Launch demo",
          author_name: "Sentry",
          provider_name: "YouTube",
          thumbnail_url: "https://i.ytimg.com/vi/demo/hqdefault.jpg",
          html: '<iframe src="https://evil.example.com"></iframe><script>alert(1)</script>',
        });
      }),
    );
    const url = "https://www.youtube.com/watch?v=oembed-demo";

    const { body, objects } = await resolveLinks([url]);

    expect(objects.get(url)).toMatchObject({
      objectType: "web_page",
      plugin: "junior",
      title: "Launch demo",
      facts: { type: "web_page", siteName: "YouTube", author: "Sentry" },
    });
    expect(asked).toEqual([url]);
    expect(body).not.toContain("iframe");
    expect(body).not.toContain("script");
    // The browser gets a Junior image path, never the provider image URL.
    expect(body).not.toContain("ytimg.com");
    const facts = objects.get(url)?.facts;
    const thumbnail =
      facts?.type === "web_page" ? facts.thumbnailUrl : undefined;
    const id = thumbnail?.match(/^\/api\/images\/([^?]+)\?w=640$/)?.[1];
    expect(id && decodeImageId(id)).toEqual({
      ref: "https://i.ytimg.com/vi/demo/hqdefault.jpg",
      source: "public",
    });
  });

  test("falls back to Open Graph tags and serves the thumbnail through the image route", async () => {
    let pageFetches = 0;
    mswServer.use(
      http.get("https://blog.example.com/posts/og", () => {
        pageFetches += 1;
        return HttpResponse.html(
          page(
            [
              "<title>Plain title</title>",
              '<meta content="Release &amp; notes" property="og:title">',
              "<meta property='og:site_name' content='Example Blog'>",
              '<meta name="description" content="What changed in 4.2.">',
              '<meta property="og:image" content="/covers/4-2.png">',
            ].join(""),
          ),
        );
      }),
      http.get(
        "https://blog.example.com/covers/4-2.png",
        () => new HttpResponse(new Uint8Array(COVER)),
      ),
    );
    const url = "https://blog.example.com/posts/og";

    const object = (await resolveLinks([url])).objects.get(url);
    expect(object).toMatchObject({
      title: "Release & notes",
      description: "What changed in 4.2.",
      facts: { type: "web_page", siteName: "Example Blog" },
    });
    const thumbnail =
      object?.facts?.type === "web_page" ? object.facts.thumbnailUrl : "";
    const image = await signedInApi().request(`http://localhost${thumbnail}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(
      await sharp(new Uint8Array(await image.arrayBuffer())).metadata(),
    ).toMatchObject({ format: "webp", width: 640 });

    // Every viewer gets the one cached card, so the page is fetched once.
    expect(
      (await resolveLinks([url], "other@example.com")).objects.get(url),
    ).toMatchObject({ title: "Release & notes" });
    expect(pageFetches).toBe(1);
  });

  test("keeps a plugin link type ahead of the web page link type", async () => {
    let pageFetches = 0;
    mswServer.use(
      http.get("https://tickets.example.com/T-1", () => {
        pageFetches += 1;
        return HttpResponse.html(
          page('<meta property="og:title" content="Page">'),
        );
      }),
    );
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "tickets",
            displayName: "Tickets",
            description: "Ticket links",
          },
          objectLinks: [
            {
              filters: [{ host: "tickets.example.com" }],
              objectType: "task",
              resolve: async (_ctx, url) => ({
                kind: "object",
                objectType: "task",
                key: "T-1",
                label: "T-1",
                title: "Plugin ticket",
                url: url.href,
              }),
            },
          ],
        }),
      ]),
    });
    const url = "https://tickets.example.com/T-1";

    expect((await resolveLinks([url])).objects.get(url)).toMatchObject({
      objectType: "task",
      plugin: "tickets",
      title: "Plugin ticket",
    });
    expect(pageFetches).toBe(0);
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
      http.get("https://redirect.example.com/page", () =>
        HttpResponse.redirect(`https://127.0.0.1:${port}/page`, 302),
      ),
      http.get("http://plain.example.com/page", () => {
        plainHits += 1;
        return HttpResponse.html(
          page('<meta property="og:title" content="Plain">'),
        );
      }),
      http.get("https://downgrade.example.com/page", () =>
        HttpResponse.redirect("http://plain.example.com/page", 302),
      ),
      http.get("https://public.example.com/page", () =>
        HttpResponse.html(page('<meta property="og:title" content="Public">')),
      ),
    );
    try {
      const urls = [
        `https://127.0.0.1:${port}/page`,
        `https://localhost:${port}/page`,
        "https://redirect.example.com/page",
        "http://plain.example.com/page",
        "https://downgrade.example.com/page",
        "https://public.example.com/page",
      ];
      const { objects } = await resolveLinks(urls);
      // Only the public page has a card. The others look like unknown links.
      expect([...objects.keys()]).toEqual(["https://public.example.com/page"]);
      expect(privateHits).toBe(0);
      expect(plainHits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("uses the first https image when an earlier image tag is plain http", async () => {
    mswServer.use(
      http.get("https://news.example.com/story", () =>
        HttpResponse.html(
          page(
            [
              '<meta property="og:title" content="Story">',
              '<meta property="og:image" content="http://cdn.example.com/plain.png">',
              '<meta name="twitter:image" content="https://cdn.example.com/secure.png">',
            ].join(""),
          ),
        ),
      ),
    );
    const url = "https://news.example.com/story";
    const facts = (await resolveLinks([url])).objects.get(url)?.facts;
    const thumbnail =
      facts?.type === "web_page" ? facts.thumbnailUrl : undefined;
    const id = thumbnail?.match(/^\/api\/images\/([^?]+)\?w=640$/)?.[1];
    expect(id && decodeImageId(id)).toEqual({
      ref: "https://cdn.example.com/secure.png",
      source: "public",
    });
  });

  test("previews other pages on the dashboard host but not dashboard pages", async () => {
    const previous = setDashboardConversationLinkOptions({
      baseURL: "https://company.example.com",
      basePath: "/junior",
    });
    let dashboardFetches = 0;
    mswServer.use(
      http.get("https://company.example.com/junior/*", () => {
        dashboardFetches += 1;
        return HttpResponse.html(
          page('<meta property="og:title" content="Dashboard">'),
        );
      }),
      http.get("https://company.example.com/blog", () =>
        HttpResponse.html(
          page('<meta property="og:title" content="Company blog">'),
        ),
      ),
    );
    try {
      const { objects } = await resolveLinks([
        "https://company.example.com/blog",
        "https://company.example.com/junior/automations",
      ]);
      expect([...objects.keys()]).toEqual(["https://company.example.com/blog"]);
      expect(dashboardFetches).toBe(0);
    } finally {
      setDashboardConversationLinkOptions(previous);
    }
  });

  test("follows at most 2 redirects", async () => {
    mswServer.use(
      http.get("https://hops.example.com/:hops", ({ params }) => {
        const hops = Number(params.hops);
        return hops === 0
          ? HttpResponse.html(
              page('<meta property="og:title" content="Arrived">'),
            )
          : HttpResponse.redirect(`https://hops.example.com/${hops - 1}`, 302);
      }),
    );
    const { objects } = await resolveLinks([
      "https://hops.example.com/2",
      "https://hops.example.com/3",
    ]);
    expect([...objects.keys()]).toEqual(["https://hops.example.com/2"]);
  });

  test("reads tags only before the size limit and only from HTML", async () => {
    mswServer.use(
      http.get("https://large.example.com/page", () =>
        HttpResponse.html(
          page(
            `<!-- ${"x".repeat(MAX_WEB_PAGE_BYTES)} --><meta property="og:title" content="Too late">`,
          ),
        ),
      ),
      http.get(
        "https://files.example.com/report",
        () =>
          new HttpResponse(page('<meta property="og:title" content="PDF">'), {
            headers: { "content-type": "application/pdf" },
          }),
      ),
      http.get(
        "https://gone.example.com/page",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get("https://small.example.com/page", () =>
        HttpResponse.html(
          page(
            `<!-- ${"x".repeat(MAX_WEB_PAGE_BYTES / 2)} --><meta property="og:title" content="In time">`,
          ),
        ),
      ),
    );
    const { objects } = await resolveLinks([
      "https://large.example.com/page",
      "https://files.example.com/report",
      "https://gone.example.com/page",
      "https://small.example.com/page",
    ]);
    expect([...objects.keys()]).toEqual(["https://small.example.com/page"]);
  });
});
