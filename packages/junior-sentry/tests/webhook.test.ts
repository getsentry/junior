import { createHmac } from "node:crypto";
import {
  eventMatches,
  type EventInput,
  type EventMatch,
} from "@sentry/junior-plugin-api";
import {
  filterEventMismatches,
  identifierMatchMismatches,
} from "@sentry/junior-testing/event-filters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentryPlugin } from "../src";
import { createSentryWebhookRoute } from "../src/webhooks/handler";
import { normalizeSentryEvents } from "../src/webhooks/events";

const SECRET = "sentry-webhook-secret";
const REQUEST_ID = "6f54fb51-5c5b-4d18-899a-3c40f13c77bb";

function issueBody(action = "created") {
  return {
    action,
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

function metricAlertBody(action = "critical") {
  return {
    action,
    data: {
      description_text:
        "1000 events in the last 10 minutes\nFilter: level:error",
      description_title: "Critical: Too many errors",
      metric_alert: {
        alert_rule: { id: "7", name: "Too many errors", projects: ["Junior"] },
        id: "4",
      },
      web_url:
        "https://sentry.sentry.io/alerts/rules/details/7/?alert=1&referrer=metric_alert_sentry_app",
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
  const events: EventInput[] = [];
  return {
    events,
    route: createSentryWebhookRoute({
      events: {
        async publish(event) {
          events.push(event);
        },
      },
      webhookSecret: () => SECRET,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sentry webhook events", () => {
  it("declares filter events that match the data the webhooks set", () => {
    // The fullest delivery of each webhook, so every optional value is set.
    const deliveries = [
      { body: issueBody(), hookResource: "issue" },
      ...["critical", "warning", "resolved"].map((action) => ({
        body: metricAlertBody(action),
        hookResource: "metric_alert",
      })),
    ];
    const events = deliveries.flatMap((delivery) =>
      normalizeSentryEvents(delivery),
    );

    expect(
      filterEventMismatches({
        resourceTypes: sentryPlugin().events?.resourceTypes ?? [],
        events,
      }),
    ).toEqual([]);
  });

  it("turns each identifier into filters that select only its events", () => {
    // Another issue and rule in the same project, and one in another project.
    const issues = [
      ["junior", "7513266773"],
      ["junior", "7513266774"],
      ["sentry", "7513266775"],
    ].map(([project, id]) => {
      const body = issueBody();
      body.data.issue.project.slug = project!;
      body.data.issue.id = id!;
      return { body, hookResource: "issue" };
    });
    const alerts = [
      ["7", "Junior", "4"],
      ["8", "junior", "5"],
      ["9", "sentry", "6"],
    ].flatMap(([ruleId, project, incidentId]) =>
      ["critical", "warning", "resolved"].map((action) => {
        const body = metricAlertBody(action);
        body.data.metric_alert = {
          alert_rule: {
            id: ruleId!,
            name: "Too many errors",
            projects: [project!],
          },
          id: incidentId!,
        };
        return { body, hookResource: "metric_alert" };
      }),
    );
    const events = [...issues, ...alerts].flatMap((delivery) =>
      normalizeSentryEvents(delivery),
    );

    // The org part is dropped: the install already fixes the org.
    const toMatch = (event: { identifier: string }): EventMatch | undefined => {
      // Saved identifiers went through the plugin's `normalizeIdentifier`.
      const identifier = event.identifier.toLowerCase();
      const alert = /^metric-alert:[^/]+\/(\d+)$/.exec(identifier);
      if (alert) return { alertRuleId: alert[1]! };
      const scope = /^[^/]+\/([^/#]+)(?:#(\d+))?$/.exec(identifier);
      if (!scope) return undefined;
      const [, project, issueId] = scope;
      return { projects: [project!], ...(issueId ? { issueId } : undefined) };
    };

    expect(
      identifierMatchMismatches({
        resourceTypes: sentryPlugin().events?.resourceTypes ?? [],
        events,
        matches: eventMatches,
        toMatch,
      }),
    ).toEqual([]);
  });

  it("drops an issue level or priority that it does not know", () => {
    const body = issueBody();
    body.data.issue.level = "critical";
    body.data.issue.priority = "urgent";

    const [event] = normalizeSentryEvents({
      body,
      hookResource: "issue",
    });

    expect(event?.data).not.toHaveProperty("level");
    expect(event?.data).not.toHaveProperty("priority");
    expect(event?.data).toMatchObject({ issueId: "7513266773" });
  });

  it("normalizes a created issue for the issue and project", () => {
    expect(
      normalizeSentryEvents({
        body: issueBody(),
        hookResource: "issue",
        hookTimestamp: "2026-08-05T23:00:01.000Z",
      }),
    ).toEqual([
      {
        data: {
          projects: ["junior"],
          issueCategory: "error",
          issueId: "7513266773",
          issueType: "error",
          level: "error",
          priority: "high",
          url: "https://sentry.sentry.io/issues/7513266773/",
        },
        eventKey: "sentry:sentry/junior#7513266773:issue.created",
        eventType: "issue.created",
        identifier: "sentry/junior#7513266773",
        objectType: "task",
        occurredAtMs: Date.parse("2026-08-05T23:00:00.000Z"),
        trustedSummary: "Sentry issue sentry/junior#7513266773 was created.",
        untrustedText: [
          "Title: TypeError: cannot read properties of undefined",
          "Culprit: api.users.create",
        ].join("\n"),
      },
      {
        data: expect.objectContaining({ level: "error" }),
        eventKey: "sentry:sentry/junior#7513266773:issue.created",
        eventType: "issue.created",
        identifier: "sentry/junior",
        objectType: "task",
        occurredAtMs: Date.parse("2026-08-05T23:00:00.000Z"),
        trustedSummary: "Sentry issue sentry/junior#7513266773 was created.",
        untrustedText: expect.any(String),
      },
    ]);
  });

  it("normalizes a metric alert state change for the alert rule and project", () => {
    expect(
      normalizeSentryEvents({
        body: metricAlertBody(),
        hookResource: "metric_alert",
        hookTimestamp: "1785976800",
      }),
    ).toEqual([
      {
        data: {
          projects: ["junior"],
          alertRuleId: "7",
          incidentId: "4",
          url: "https://sentry.sentry.io/alerts/rules/details/7/?alert=1&referrer=metric_alert_sentry_app",
        },
        eventKey: "sentry:metric-alert:sentry/7:4:metric_alert.critical",
        eventType: "metric_alert.critical",
        identifier: "metric-alert:sentry/7",
        objectType: "item",
        occurredAtMs: 1_785_976_800_000,
        trustedSummary: "Sentry metric alert sentry/7 is critical.",
        untrustedText: [
          "Critical: Too many errors",
          "1000 events in the last 10 minutes",
          "Filter: level:error",
        ].join("\n"),
      },
      {
        data: expect.any(Object),
        eventKey: "sentry:metric-alert:sentry/7:4:metric_alert.critical",
        eventType: "metric_alert.critical",
        identifier: "sentry/junior",
        objectType: "item",
        occurredAtMs: 1_785_976_800_000,
        trustedSummary: "Sentry metric alert sentry/7 is critical.",
        untrustedText: expect.any(String),
      },
    ]);
  });

  it("leaves out alert rule projects that do not fit in event data", () => {
    const body = metricAlertBody();
    body.data.metric_alert.alert_rule.projects = Array.from(
      { length: 200 },
      (_, index) => `project-with-a-long-slug-${index}`,
    );

    const events = normalizeSentryEvents({
      body,
      hookResource: "metric_alert",
    });

    expect(events).toHaveLength(201);
    expect(events[0]?.data).not.toHaveProperty("projects");
    expect(events[0]?.data).toMatchObject({ alertRuleId: "7" });
  });

  it("ignores a metric alert without an organization or with an unsupported state", () => {
    const noOrg = metricAlertBody();
    noOrg.data.web_url = "https://sentry.io/alerts/rules/details/7/";

    for (const body of [noOrg, metricAlertBody("triggered")]) {
      expect(
        normalizeSentryEvents({
          body,
          hookResource: "metric_alert",
        }),
      ).toEqual([]);
    }
  });

  it("parses Sentry-Hook-Timestamp unix seconds when firstSeen is absent", () => {
    const body = issueBody();
    delete body.data.issue.firstSeen;

    expect(
      normalizeSentryEvents({
        body,
        hookResource: "issue",
        hookTimestamp: "1785976800",
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
    vi.stubEnv("SENTRY_WEBHOOK_SECRET", ` ${SECRET} `);
    const publish = vi.fn(async () => {});
    const [route] =
      sentryPlugin().hooks?.routes?.({
        events: { publish },
      } as never) ?? [];

    const response = await route?.handler(signedRequest(issueBody()));

    expect(response?.status).toBe(202);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("uses the organization from the signed payload", async () => {
    const fixture = routeFixture();
    const body = issueBody();
    body.data.issue.url =
      "https://sentry.io/api/0/organizations/other/issues/7513266773/";

    const response = await fixture.route.handler(signedRequest(body));

    expect(response.status).toBe(202);
    expect(fixture.events.map((event) => event.identifier)).toEqual([
      "other/junior#7513266773",
      "other/junior",
    ]);
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
      events: {
        async publish() {
          throw new Error("queue unavailable");
        },
      },
      webhookSecret: () => SECRET,
    });

    await expect(route.handler(signedRequest(issueBody()))).rejects.toThrow(
      "queue unavailable",
    );
  });
});
