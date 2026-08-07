import { createHmac } from "node:crypto";
import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentryPlugin } from "../src";
import { createSentryWebhookRoute } from "../src/webhooks/handler";
import { normalizeSentryResourceEvents } from "../src/webhooks/resource-events";

const SECRET = "sentry-webhook-secret";
const REQUEST_ID = "6f54fb51-5c5b-4d18-899a-3c40f13c77bb";

function issueBody(action = "created") {
  return {
    action,
    actor: { id: "sentry", name: "Sentry", type: "application" },
    data: {
      issue: {
        culprit: "api.users.create",
        firstSeen: "2026-08-05T23:00:00.000Z",
        id: "7513266773",
        issueCategory: "error",
        issueType: "error",
        level: "error",
        priority: "high",
        project: { id: "4510944073809921", slug: "junior" },
        status: "unresolved",
        substatus: "new",
        title: "TypeError: cannot read properties of undefined",
        url: "https://sentry.io/api/0/organizations/sentry/issues/7513266773/",
        web_url: "https://sentry.sentry.io/issues/7513266773/",
      },
    },
    installation: { uuid: "24b397fc-a86e-43ef-9297-949e21b82480" },
  };
}

function signedRawRequest(
  rawBody: string,
  options: {
    secret?: string;
    requestId?: string;
    resource?: string;
  } = {},
): Request {
  const secret = options.secret ?? SECRET;
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sentry-hook-resource": options.resource ?? "issue",
    "sentry-hook-signature": signature,
    "sentry-hook-timestamp": "2026-08-05T23:00:01.000Z",
  };
  if (options.requestId !== "") {
    headers["request-id"] = options.requestId ?? REQUEST_ID;
  }
  return new Request("https://example.test/api/webhooks/sentry", {
    body: rawBody,
    headers,
    method: "POST",
  });
}

function signedRequest(
  body: unknown,
  options?: Parameters<typeof signedRawRequest>[1],
): Request {
  return signedRawRequest(JSON.stringify(body), options);
}

function routeFixture() {
  const events: ResourceEventInput[] = [];
  return {
    events,
    route: createSentryWebhookRoute({
      resourceEvents: {
        async publish(event) {
          events.push(event);
        },
      },
      webhookOrg: () => "sentry",
      webhookSecret: () => SECRET,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sentry webhook resource events", () => {
  it("normalizes a created issue for the issue and project", () => {
    expect(
      normalizeSentryResourceEvents({
        body: issueBody(),
        hookResource: "issue",
        hookTimestamp: "2026-08-05T23:00:01.000Z",
        webhookOrg: "sentry",
      }),
    ).toEqual([
      {
        eventKey: "sentry:sentry/junior#7513266773:issue.created",
        eventType: "issue.created",
        identifier: "sentry/junior#7513266773",
        occurredAtMs: Date.parse("2026-08-05T23:00:00.000Z"),
        trustedSummary: "Sentry issue sentry/junior#7513266773 was created.",
        untrustedText: [
          "Title: TypeError: cannot read properties of undefined",
          "Culprit: api.users.create",
          "Level: error",
          "Priority: high",
          "Category: error",
          "Type: error",
          "Status: unresolved",
          "Substatus: new",
          "URL: https://sentry.sentry.io/issues/7513266773/",
        ].join("\n"),
      },
      {
        eventKey: "sentry:sentry/junior#7513266773:issue.created",
        eventType: "issue.created",
        identifier: "sentry/junior",
        occurredAtMs: Date.parse("2026-08-05T23:00:00.000Z"),
        trustedSummary: "Sentry issue sentry/junior#7513266773 was created.",
        untrustedText: expect.any(String),
      },
    ]);
  });

  it("parses Sentry-Hook-Timestamp unix seconds when firstSeen is absent", () => {
    const body = issueBody();
    delete body.data.issue.firstSeen;

    expect(
      normalizeSentryResourceEvents({
        body,
        hookResource: "issue",
        hookTimestamp: "1785976800",
        webhookOrg: "sentry",
      }),
    ).toEqual([
      expect.objectContaining({ occurredAtMs: 1_785_976_800_000 }),
      expect.objectContaining({ occurredAtMs: 1_785_976_800_000 }),
    ]);
  });

  it("publishes both events from a valid signed delivery", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(signedRequest(issueBody()));

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Accepted");
    expect(fixture.events.map((event) => event.identifier)).toEqual([
      "sentry/junior#7513266773",
      "sentry/junior",
    ]);
  });

  it("uses a stable event key when Sentry retries with a new request id", async () => {
    const fixture = routeFixture();

    await fixture.route.handler(
      signedRequest(issueBody(), { requestId: "delivery-attempt-1" }),
    );
    await fixture.route.handler(
      signedRequest(issueBody(), { requestId: "delivery-attempt-2" }),
    );

    expect(new Set(fixture.events.map((event) => event.eventKey))).toEqual(
      new Set(["sentry:sentry/junior#7513266773:issue.created"]),
    );
  });

  it("uses the trimmed environment secret for plugin ingress", async () => {
    vi.stubEnv("SENTRY_WEBHOOK_ORG", " SENTRY ");
    vi.stubEnv("SENTRY_WEBHOOK_SECRET", ` ${SECRET} `);
    const publish = vi.fn(async () => {});
    const [route] =
      sentryPlugin().hooks?.routes?.({
        resourceEvents: { publish },
      } as never) ?? [];

    const response = await route?.handler(signedRequest(issueBody()));

    expect(response?.status).toBe(202);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("ignores a signed delivery for a different organization", async () => {
    const fixture = routeFixture();
    const body = issueBody();
    body.data.issue.url =
      "https://sentry.io/api/0/organizations/other/issues/7513266773/";

    const response = await fixture.route.handler(signedRequest(body));

    expect(response.status).toBe(202);
    expect(fixture.events).toEqual([]);
  });

  it("rejects a delivery whose signature does not match", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(
      signedRequest(issueBody(), { secret: "wrong-secret" }),
    );

    expect(response.status).toBe(401);
    expect(fixture.events).toEqual([]);
  });

  it("rejects a signed delivery without a request id", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(
      signedRequest(issueBody(), { requestId: "" }),
    );

    expect(response.status).toBe(400);
    expect(fixture.events).toEqual([]);
  });

  it("accepts but ignores unsupported resources and actions", async () => {
    const fixture = routeFixture();

    const unsupportedResource = await fixture.route.handler(
      signedRequest(issueBody(), { resource: "comment" }),
    );
    const unsupportedAction = await fixture.route.handler(
      signedRequest(issueBody("resolved")),
    );

    expect(unsupportedResource.status).toBe(202);
    expect(unsupportedAction.status).toBe(202);
    expect(fixture.events).toEqual([]);
  });

  it("returns a client error for malformed signed JSON", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(signedRawRequest("not-json"));

    expect(response.status).toBe(400);
    expect(fixture.events).toEqual([]);
  });

  it("propagates publisher failures so Sentry can retry", async () => {
    const route = createSentryWebhookRoute({
      resourceEvents: {
        async publish() {
          throw new Error("queue unavailable");
        },
      },
      webhookOrg: () => "sentry",
      webhookSecret: () => SECRET,
    });

    await expect(route.handler(signedRequest(issueBody()))).rejects.toThrow(
      "queue unavailable",
    );
  });
});
