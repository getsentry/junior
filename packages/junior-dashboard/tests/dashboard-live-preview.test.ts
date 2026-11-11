import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app";
import { withLivePreview } from "../src/live-preview";

const TOKEN = "jr_live_token";

// A stand-in for the live deployment. It accepts only TOKEN, like a
// personal token on a real deployment.
let live: Server;
let liveOrigin: string;
const liveRequests: { headers: IncomingHttpHeaders; url?: string }[] = [];

beforeAll(async () => {
  live = createServer((request, response) => {
    liveRequests.push({ headers: request.headers, url: request.url });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthenticated" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "live=1",
    });
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
  liveOrigin = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => live.close(resolve));
});

afterEach(() => {
  liveRequests.length = 0;
});

function dashboard() {
  return withLivePreview(
    createDashboardApp({
      allowedDomains: [],
      authRequired: false,
      mockConversations: true,
    }),
    liveOrigin,
  );
}

function basic(token: string): HeadersInit {
  return {
    authorization: `Basic ${Buffer.from(`viewer:${token}`).toString("base64")}`,
  };
}

function embeddedPreview(html: string): unknown {
  const match = /window\.__JUNIOR_DASHBOARD_PREVIEW__ = (.*?);<\/script>/.exec(
    html,
  );
  return match ? JSON.parse(match[1]!) : undefined;
}

describe("dashboard live preview", () => {
  it("serves mock data without credentials", async () => {
    const app = dashboard();

    const api = await app.fetch(new Request("http://preview/api/me"));
    const page = await app.fetch(new Request("http://preview/"));
    const html = await page.text();

    expect(api.status).toBe(200);
    expect(liveRequests).toEqual([]);
    expect(embeddedPreview(html)).toEqual({ live: false, liveOrigin });
  });

  it("asks for a personal token until the live deployment accepts one", async () => {
    const app = dashboard();

    const missing = await app.fetch(new Request("http://preview/?live"));
    const rejected = await app.fetch(
      new Request("http://preview/?live", { headers: basic("wrong") }),
    );
    const accepted = await app.fetch(
      new Request("http://preview/?live", { headers: basic(TOKEN) }),
    );

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toBe("http://preview/");
  });

  it("forwards API reads to the live deployment with the token", async () => {
    const app = dashboard();

    const api = await app.fetch(
      new Request("http://preview/api/conversations?q=deploy", {
        headers: { ...basic(TOKEN), cookie: "preview=1" },
      }),
    );
    const page = await app.fetch(
      new Request("http://preview/", { headers: basic(TOKEN) }),
    );
    const html = await page.text();

    expect(await api.json()).toEqual({ url: "/api/conversations?q=deploy" });
    expect(api.headers.get("set-cookie")).toBeNull();
    expect(liveRequests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(liveRequests[0]?.headers.cookie).toBeUndefined();
    expect(embeddedPreview(html)).toEqual({ live: true, liveOrigin });
  });

  it("keeps live data read-only", async () => {
    const app = dashboard();

    const response = await app.fetch(
      new Request("http://preview/api/conversations", {
        body: "{}",
        headers: basic(TOKEN),
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(liveRequests).toEqual([]);
  });

  it("reports a rejected token without restarting sign-in", async () => {
    const app = dashboard();

    const response = await app.fetch(
      new Request("http://preview/api/me", { headers: basic("revoked") }),
    );

    expect(response.status).toBe(403);
  });
});
