import { createHmac } from "node:crypto";
import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";
import { createVercelWebhookRoute } from "../src/webhooks/handler";
import { normalizeVercelResourceEvents } from "../src/webhooks/resource-events";

const SECRET = "vercel-webhook-secret";
const COMMIT_SHA = "abcdef0123456789abcdef0123456789abcdef01";

afterEach(() => {
  vi.unstubAllEnvs();
});

function webhookBody(
  type:
    | "deployment.canceled"
    | "deployment.error"
    | "deployment.succeeded" = "deployment.succeeded",
  target: string | null = "production",
) {
  return {
    createdAt: 1_784_043_000_000,
    id: "evt_delivery_123",
    payload: {
      deployment: {
        id: "dpl_123abc",
        meta: { githubCommitSha: COMMIT_SHA },
      },
      project: { id: "prj_junior" },
      target,
    },
    type,
  };
}

function signedRawRequest(rawBody: string, secret = SECRET): Request {
  const signature = createHmac("sha1", secret).update(rawBody).digest("hex");
  return new Request("https://example.test/api/webhooks/vercel", {
    body: rawBody,
    headers: { "x-vercel-signature": signature },
    method: "POST",
  });
}

function signedRequest(body: unknown, secret = SECRET): Request {
  return signedRawRequest(JSON.stringify(body), secret);
}

function routeFixture() {
  const events: ResourceEventInput[] = [];
  return {
    events,
    route: createVercelWebhookRoute({
      resourceEvents: {
        async publish(event) {
          events.push(event);
        },
      },
      webhookSecret: () => SECRET,
    }),
  };
}

describe("Vercel webhook resource events", () => {
  it.each([
    ["deployment.succeeded", "succeeded"],
    ["deployment.error", "failed"],
    ["deployment.canceled", "was canceled"],
  ] as const)(
    "normalizes %s across project, target, and commit watches",
    (eventType, outcome) => {
      expect(
        normalizeVercelResourceEvents({ body: webhookBody(eventType) }),
      ).toEqual([
        {
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          occurredAtMs: 1_784_043_000_000,
          identifier: "prj_junior",
          trustedSummary: `Vercel deployments for prj_junior (dpl_123abc) ${outcome}.`,
          untrustedText: `Target: production
Commit: ${COMMIT_SHA}
Deployment: dpl_123abc`,
        },
        {
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          occurredAtMs: 1_784_043_000_000,
          identifier: "prj_junior:production",
          trustedSummary: `Vercel production deployments for prj_junior (dpl_123abc) ${outcome}.`,
          untrustedText: `Target: production
Commit: ${COMMIT_SHA}
Deployment: dpl_123abc`,
        },
        {
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          occurredAtMs: 1_784_043_000_000,
          identifier: `prj_junior:production:${COMMIT_SHA}`,
          terminal: true,
          trustedSummary: `Vercel production deployment for prj_junior at abcdef012345 (dpl_123abc) ${outcome}.`,
          untrustedText: `Target: production
Commit: ${COMMIT_SHA}
Deployment: dpl_123abc`,
        },
      ]);
    },
  );

  it("maps a null Vercel target and alternate Git provider metadata to preview", () => {
    const body = webhookBody("deployment.succeeded", null);
    body.payload.deployment.meta = {
      gitlabCommitSha: COMMIT_SHA.toUpperCase(),
    };

    expect(normalizeVercelResourceEvents({ body })).toEqual([
      expect.objectContaining({
        identifier: "prj_junior",
      }),
      expect.objectContaining({
        identifier: "prj_junior:preview",
      }),
      expect.objectContaining({
        identifier: `prj_junior:preview:${COMMIT_SHA}`,
        terminal: true,
      }),
    ]);
  });

  it("still fans out project and target watches when commit metadata is missing", () => {
    const body = webhookBody();
    body.payload.deployment.meta = {};

    expect(normalizeVercelResourceEvents({ body })).toEqual([
      {
        eventKey: "vercel:evt_delivery_123:deployment.succeeded",
        eventType: "deployment.succeeded",
        occurredAtMs: 1_784_043_000_000,
        identifier: "prj_junior",
        trustedSummary:
          "Vercel deployments for prj_junior (dpl_123abc) succeeded.",
        untrustedText: "Target: production\nDeployment: dpl_123abc",
      },
      {
        eventKey: "vercel:evt_delivery_123:deployment.succeeded",
        eventType: "deployment.succeeded",
        occurredAtMs: 1_784_043_000_000,
        identifier: "prj_junior:production",
        trustedSummary:
          "Vercel production deployments for prj_junior (dpl_123abc) succeeded.",
        untrustedText: "Target: production\nDeployment: dpl_123abc",
      },
    ]);
  });

  it("rejects undocumented fields at each routing boundary", () => {
    const body = webhookBody();
    const payloads = [
      { ...body, unexpected: true },
      { ...body, payload: { ...body.payload, unexpected: true } },
      {
        ...body,
        payload: {
          ...body.payload,
          deployment: { ...body.payload.deployment, unexpected: true },
        },
      },
      {
        ...body,
        payload: {
          ...body.payload,
          project: { ...body.payload.project, unexpected: true },
        },
      },
    ];

    for (const payload of payloads) {
      expect(normalizeVercelResourceEvents({ body: payload })).toEqual([]);
    }
  });

  it("rejects a non-numeric event timestamp", () => {
    expect(
      normalizeVercelResourceEvents({
        body: { ...webhookBody(), createdAt: "2026-07-22T12:00:00Z" },
      }),
    ).toEqual([]);
  });

  it("publishes every matching watch from a valid signed delivery", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(signedRequest(webhookBody()));

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Accepted");
    expect(fixture.events).toEqual([
      expect.objectContaining({
        eventType: "deployment.succeeded",
        identifier: "prj_junior",
      }),
      expect.objectContaining({
        eventType: "deployment.succeeded",
        identifier: "prj_junior:production",
      }),
      expect.objectContaining({
        eventType: "deployment.succeeded",
        identifier: `prj_junior:production:${COMMIT_SHA}`,
        terminal: true,
      }),
    ]);
  });

  it("uses the same trimmed environment secret for plugin ingress", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", ` ${SECRET} `);
    const publish = vi.fn(async () => {});
    const [route] =
      vercelPlugin().hooks?.routes?.({
        resourceEvents: { publish },
      } as never) ?? [];

    const response = await route?.handler(signedRequest(webhookBody()));

    expect(response?.status).toBe(202);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("rejects a delivery whose signature does not match", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(
      signedRequest(webhookBody(), "wrong-secret"),
    );

    expect(response.status).toBe(401);
    expect(fixture.events).toEqual([]);
  });

  it("accepts and publishes project watches when commit metadata is missing", async () => {
    const fixture = routeFixture();
    const body = webhookBody();
    body.payload.deployment.meta = {};

    const response = await fixture.route.handler(signedRequest(body));

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Accepted");
    expect(fixture.events).toEqual([
      expect.objectContaining({
        identifier: "prj_junior",
      }),
      expect.objectContaining({
        identifier: "prj_junior:production",
      }),
    ]);
  });

  it("returns a client error for malformed signed JSON", async () => {
    const fixture = routeFixture();
    const rawBody = "not-json";
    const request = signedRawRequest(rawBody);

    const response = await fixture.route.handler(request);

    expect(response.status).toBe(400);
    expect(fixture.events).toEqual([]);
  });

  it("propagates publisher failures so Vercel can retry", async () => {
    const route = createVercelWebhookRoute({
      resourceEvents: {
        publish: vi.fn(async () => {
          throw new Error("queue unavailable");
        }),
      },
      webhookSecret: () => SECRET,
    });

    await expect(route.handler(signedRequest(webhookBody()))).rejects.toThrow(
      "queue unavailable",
    );
  });
});
