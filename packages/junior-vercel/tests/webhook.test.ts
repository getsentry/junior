import { createHmac } from "node:crypto";
import { eventMatches, type EventInput } from "@sentry/junior-plugin-api";
import {
  filterEventMismatches,
  identifierMatchMismatches,
} from "@sentry/junior-testing/event-filters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";
import { createVercelWebhookRoute } from "../src/webhooks/handler";
import { normalizeVercelEvents } from "../src/webhooks/events";

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
  const events: EventInput[] = [];
  return {
    events,
    route: createVercelWebhookRoute({
      events: {
        async publish(event) {
          events.push(event);
        },
      },
      webhookSecret: () => SECRET,
    }),
  };
}

describe("Vercel webhook events", () => {
  it("declares filter events that match the data the webhooks set", () => {
    // The fixture deployment has a Git commit, so every optional value is set.
    const events = (
      [
        "deployment.succeeded",
        "deployment.error",
        "deployment.canceled",
      ] as const
    ).flatMap((type) => normalizeVercelEvents({ body: webhookBody(type) }));

    expect(
      filterEventMismatches({
        resourceTypes: vercelPlugin().events?.resourceTypes ?? [],
        events,
      }),
    ).toEqual([]);
  });

  it("turns each identifier into filters that select only its events", () => {
    // Another target, another commit, and another project.
    const deployments = [
      ["prj_junior", "production", COMMIT_SHA],
      ["prj_junior", "preview", COMMIT_SHA],
      ["prj_junior", "production", "f".repeat(40)],
      ["prj_other", "production", COMMIT_SHA],
    ];
    const events = (
      [
        "deployment.succeeded",
        "deployment.error",
        "deployment.canceled",
      ] as const
    ).flatMap((type) =>
      deployments.flatMap(([projectId, target, commitSha], index) => {
        const body = webhookBody(type, target);
        body.id = `evt_delivery_${index}`;
        body.payload.deployment = {
          id: `dpl_${index}`,
          meta: { githubCommitSha: commitSha! },
        };
        body.payload.project.id = projectId!;
        return normalizeVercelEvents({ body });
      }),
    );
    const toMatch = vercelPlugin().events?.identifierMatch;
    if (!toMatch) throw new Error("Vercel identifiers must convert to filters");

    expect(
      identifierMatchMismatches({
        resourceTypes: vercelPlugin().events?.resourceTypes ?? [],
        events,
        matches: eventMatches,
        toMatch,
      }),
    ).toEqual([]);
  });

  it.each([
    ["deployment.succeeded", "succeeded"],
    ["deployment.error", "failed"],
    ["deployment.canceled", "was canceled"],
  ] as const)(
    "normalizes %s across project, target, and commit watches",
    (eventType, outcome) => {
      expect(normalizeVercelEvents({ body: webhookBody(eventType) })).toEqual([
        {
          data: {
            commitSha: COMMIT_SHA,
            deploymentId: "dpl_123abc",
            projectId: "prj_junior",
            target: "production",
          },
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          objectType: "deployment",
          occurredAtMs: 1_784_043_000_000,
          identifier: "prj_junior",
          trustedSummary: `Vercel deployments for prj_junior (dpl_123abc) ${outcome}.`,
        },
        {
          data: {
            commitSha: COMMIT_SHA,
            deploymentId: "dpl_123abc",
            projectId: "prj_junior",
            target: "production",
          },
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          objectType: "deployment",
          occurredAtMs: 1_784_043_000_000,
          identifier: "prj_junior:production",
          trustedSummary: `Vercel production deployments for prj_junior (dpl_123abc) ${outcome}.`,
        },
        {
          data: {
            commitSha: COMMIT_SHA,
            deploymentId: "dpl_123abc",
            projectId: "prj_junior",
            target: "production",
          },
          eventKey: `vercel:evt_delivery_123:${eventType}`,
          eventType,
          objectType: "deployment",
          occurredAtMs: 1_784_043_000_000,
          identifier: `prj_junior:production:${COMMIT_SHA}`,
          terminal: true,
          trustedSummary: `Vercel production deployment for prj_junior at abcdef012345 (dpl_123abc) ${outcome}.`,
        },
      ]);
    },
  );

  it("ignores whitespace-only project IDs", () => {
    const body = webhookBody();
    body.payload.project.id = " ";

    expect(normalizeVercelEvents({ body })).toEqual([]);
  });

  it("accepts an opaque Vercel project ID", () => {
    const body = webhookBody();
    body.payload.project.id = "QmLegacyProject123";

    expect(normalizeVercelEvents({ body })).toEqual([
      expect.objectContaining({ identifier: "QmLegacyProject123" }),
      expect.objectContaining({
        identifier: "QmLegacyProject123:production",
      }),
      expect.objectContaining({
        identifier: `QmLegacyProject123:production:${COMMIT_SHA}`,
      }),
    ]);
  });

  it("maps a null Vercel target to preview and skips bad commit metadata", () => {
    const body = webhookBody("deployment.succeeded", null);
    body.payload.deployment.meta = {
      githubCommitSha: "not-a-sha",
      gitlabCommitSha: COMMIT_SHA.toUpperCase(),
    };

    expect(normalizeVercelEvents({ body })).toEqual([
      expect.objectContaining({
        identifier: "prj_junior",
      }),
      expect.objectContaining({
        identifier: "prj_junior:preview",
      }),
      expect.objectContaining({
        data: {
          commitSha: COMMIT_SHA,
          deploymentId: "dpl_123abc",
          projectId: "prj_junior",
          target: "preview",
        },
        identifier: `prj_junior:preview:${COMMIT_SHA}`,
        terminal: true,
      }),
    ]);
  });

  it("still fans out project and target watches when commit metadata is missing", () => {
    const body = webhookBody();
    body.payload.deployment.meta = {};

    expect(normalizeVercelEvents({ body })).toEqual([
      {
        data: {
          deploymentId: "dpl_123abc",
          projectId: "prj_junior",
          target: "production",
        },
        eventKey: "vercel:evt_delivery_123:deployment.succeeded",
        eventType: "deployment.succeeded",
        objectType: "deployment",
        occurredAtMs: 1_784_043_000_000,
        identifier: "prj_junior",
        trustedSummary:
          "Vercel deployments for prj_junior (dpl_123abc) succeeded.",
      },
      {
        data: {
          deploymentId: "dpl_123abc",
          projectId: "prj_junior",
          target: "production",
        },
        eventKey: "vercel:evt_delivery_123:deployment.succeeded",
        eventType: "deployment.succeeded",
        objectType: "deployment",
        occurredAtMs: 1_784_043_000_000,
        identifier: "prj_junior:production",
        trustedSummary:
          "Vercel production deployments for prj_junior (dpl_123abc) succeeded.",
      },
    ]);
  });

  it("ignores unknown fields at each level", () => {
    const body = webhookBody();
    const withUnknownFields = {
      ...body,
      unknown: true,
      payload: {
        ...body.payload,
        unknown: true,
        deployment: { ...body.payload.deployment, unknown: true },
        project: { ...body.payload.project, unknown: true },
      },
    };

    expect(
      normalizeVercelEvents({ body: withUnknownFields }).map(
        (event) => event.identifier,
      ),
    ).toEqual([
      "prj_junior",
      "prj_junior:production",
      `prj_junior:production:${COMMIT_SHA}`,
    ]);
  });

  it("rejects a non-numeric event timestamp", () => {
    expect(
      normalizeVercelEvents({
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
        events: { publish },
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
      events: {
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
