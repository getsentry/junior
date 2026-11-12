import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JUNIOR_VERSION } from "@sentry/junior/version";
import { createDashboardApp } from "../src/app";
// The wrapper belongs to the example app, so no Junior package ships it.
// It runs here, against the real dashboard app.
import { withLivePreview } from "../../../apps/example/live-preview";

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
    if (request.url === "/api/moved") {
      response.writeHead(302, { location: "/api/conversations" });
      response.end();
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

function withToken(token: string): HeadersInit {
  return { cookie: `other=1; junior_live_token=${token}` };
}

function sendToken(token: string, origin: string): Request {
  return new Request("http://preview/?live", {
    body: new URLSearchParams({ token }),
    headers: { origin },
    method: "POST",
  });
}

describe("dashboard live preview", () => {
  it("serves mock data without credentials", async () => {
    const app = dashboard();

    const api = await app.fetch(new Request("http://preview/api/me"));
    const page = await app.fetch(new Request("http://preview/"));
    const html = await page.text();

    expect(api.status).toBe(200);
    expect(liveRequests).toEqual([]);
    expect(html).toContain("Demo data.");
    expect(html).not.toContain("delete window.__JUNIOR_DASHBOARD_BOOTSTRAP__");
  });

  it("asks for a personal token until the live deployment accepts one", async () => {
    const app = dashboard();

    const missing = await app.fetch(new Request("http://preview/?live"));
    const stale = await app.fetch(
      new Request("http://preview/?live", { headers: withToken("revoked") }),
    );
    const accepted = await app.fetch(
      new Request("http://preview/?live", { headers: withToken(TOKEN) }),
    );

    expect(missing.status).toBe(200);
    const html = await missing.text();
    expect(html).toContain(`${liveOrigin}/settings/api-tokens?preview=`);
    expect(html).toContain("?name=Live+preview+on+preview");
    expect(stale.status).toBe(200);
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toBe("http://preview/");
  });

  it("keeps a token that the live deployment or the paste form sends", async () => {
    const app = dashboard();

    const fromLive = await app.fetch(sendToken(TOKEN, liveOrigin));
    const pasted = await app.fetch(sendToken(TOKEN, "https://preview"));

    for (const response of [fromLive, pasted]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      expect(response.headers.get("set-cookie")).toBe(
        `junior_live_token=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
      );
    }
  });

  it("refuses a token from another site or one the live deployment rejects", async () => {
    const app = dashboard();

    const otherSite = await app.fetch(sendToken(TOKEN, "https://evil.example"));
    const rejected = await app.fetch(sendToken("wrong", liveOrigin));

    expect(otherSite.status).toBe(403);
    expect(otherSite.headers.get("set-cookie")).toBeNull();
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("set-cookie")).toBeNull();
    // The other site never reaches the live deployment.
    expect(
      liveRequests.map((request) => request.headers.authorization),
    ).toEqual(["Bearer wrong"]);
  });

  it("forwards API reads to the live deployment with the token", async () => {
    const app = dashboard();

    const api = await app.fetch(
      new Request("http://preview/api/conversations?q=deploy", {
        headers: {
          cookie: `preview=1; junior_live_token=${TOKEN}`,
          "x-junior-detail-version": "v1",
        },
      }),
    );
    const page = await app.fetch(
      new Request("http://preview/", { headers: withToken(TOKEN) }),
    );
    const html = await page.text();

    expect(await api.json()).toEqual({ url: "/api/conversations?q=deploy" });
    expect(api.headers.get("set-cookie")).toBeNull();
    expect(api.headers.get("x-junior-version")).toBe(JUNIOR_VERSION);
    expect(liveRequests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Forward only the token, not the cookie that holds it.
    expect(liveRequests[0]?.headers.cookie).toBeUndefined();
    expect(liveRequests[0]?.headers["x-junior-detail-version"]).toBe("v1");
    expect(html).toContain("You are seeing a preview of");
    expect(html).toContain("delete window.__JUNIOR_DASHBOARD_BOOTSTRAP__");
  });

  it("follows live redirects with the token", async () => {
    const app = dashboard();

    const response = await app.fetch(
      new Request("http://preview/api/moved", { headers: withToken(TOKEN) }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "/api/conversations" });
    expect(liveRequests[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps live data read-only", async () => {
    const app = dashboard();

    const response = await app.fetch(
      new Request("http://preview/api/conversations", {
        body: "{}",
        headers: withToken(TOKEN),
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
    expect(liveRequests).toEqual([]);
  });

  it("reports a rejected token without restarting sign-in", async () => {
    const app = dashboard();

    const response = await app.fetch(
      new Request("http://preview/api/me", { headers: withToken("revoked") }),
    );

    expect(response.status).toBe(403);
  });
});
