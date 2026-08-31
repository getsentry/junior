import { createHmac } from "node:crypto";
import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linearPlugin } from "../src";
import { createLinearWebhookRoute } from "../src/webhooks/handler";
import { normalizeLinearResourceEvents } from "../src/webhooks/resource-events";

const SECRET = "linear-webhook-secret";

function issueBody(action = "create") {
  return {
    action,
    actor: { id: "user-1", name: "Linear Orbit", type: "user" },
    createdAt: "2026-08-14T15:00:00.000Z",
    data: {
      assignee: { id: "user-2", name: "Bojan Oro" },
      description: "Disk xyz is approaching 80% capacity.",
      id: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
      identifier: "SRE-123",
      labels: [{ id: "label-1", name: "datadog" }],
      priorityLabel: "High",
      project: { id: "project-1", name: "SRE monitors" },
      state: { id: "state-1", name: "Triage" },
      team: { id: "team-1", key: "SRE", name: "Site Reliability" },
      title: "Disk xyz is approaching capacity",
      url: "https://linear.app/getsentry/issue/SRE-123/disk-xyz",
    },
    type: "Issue",
    url: "https://linear.app/getsentry/issue/SRE-123/disk-xyz",
    webhookTimestamp: 1_786_719_600_000,
  };
}

function signedRawRequest(
  rawBody: string,
  options: {
    delivery?: string;
    event?: string;
    secret?: string;
  } = {},
): Request {
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(rawBody)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "linear-event": options.event ?? "Issue",
    "linear-signature": signature,
  };
  if (options.delivery !== "") {
    headers["linear-delivery"] = options.delivery ?? "delivery-1";
  }
  return new Request("https://example.test/api/webhooks/linear", {
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
    route: createLinearWebhookRoute({
      resourceEvents: {
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

describe("Linear webhook resource events", () => {
  it("registers teamKey match fields on issue and team resources", () => {
    const resourceTypes = linearPlugin().resourceEvents?.resourceTypes ?? [];

    expect(resourceTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "issue",
          matchFields: {
            teamKey: {
              kind: "string",
              description: "Linear team key for the issue, such as SRE",
            },
          },
        }),
        expect.objectContaining({
          type: "team",
          matchFields: {
            teamKey: {
              kind: "string",
              description: "Linear team key for the issue, such as SRE",
            },
          },
        }),
      ]),
    );
  });

  it("normalizes a created issue for the issue and team", () => {
    expect(
      normalizeLinearResourceEvents({
        body: issueBody(),
        linearEvent: "Issue",
      }),
    ).toEqual([
      {
        data: {
          issueId: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
          issueIdentifier: "SRE-123",
          teamKey: "SRE",
          url: "https://linear.app/getsentry/issue/SRE-123/disk-xyz",
        },
        eventKey: "linear:2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9:issue.created",
        eventType: "issue.created",
        identifier: "SRE-123",
        occurredAtMs: Date.parse("2026-08-14T15:00:00.000Z"),
        trustedSummary: "Linear issue SRE-123 was created.",
        untrustedText: [
          "Title: Disk xyz is approaching capacity",
          "Description: Disk xyz is approaching 80% capacity.",
          "State: Triage",
          "Priority: High",
          "Project: SRE monitors",
          "Labels: datadog",
          "Assignee: Bojan Oro",
          "URL: https://linear.app/getsentry/issue/SRE-123/disk-xyz",
        ].join("\n"),
      },
      expect.objectContaining({
        identifier: "SRE",
        trustedSummary: "Linear issue SRE-123 was created.",
      }),
    ]);
  });

  it("publishes both events from a valid signed delivery", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(signedRequest(issueBody()));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("Accepted");
    expect(fixture.events.map((event) => event.identifier)).toEqual([
      "SRE-123",
      "SRE",
    ]);
  });

  it("uses a stable event key across webhook delivery retries", async () => {
    const fixture = routeFixture();

    await fixture.route.handler(
      signedRequest(issueBody(), { delivery: "delivery-1" }),
    );
    await fixture.route.handler(
      signedRequest(issueBody(), { delivery: "delivery-2" }),
    );

    expect(new Set(fixture.events.map((event) => event.eventKey))).toEqual(
      new Set(["linear:2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9:issue.created"]),
    );
  });

  it("uses the trimmed environment secret for plugin ingress", async () => {
    vi.stubEnv("LINEAR_WEBHOOK_SECRET", ` ${SECRET} `);
    const publish = vi.fn(async () => {});
    const [route] =
      linearPlugin().hooks?.routes?.({
        resourceEvents: { publish },
      } as never) ?? [];

    const response = await route?.handler(signedRequest(issueBody()));

    expect(response?.status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(linearPlugin().resourceEvents?.isEnabled?.()).toBe(true);
  });

  it("rejects a delivery whose signature does not match", async () => {
    const fixture = routeFixture();

    const response = await fixture.route.handler(
      signedRequest(issueBody(), { secret: "wrong-secret" }),
    );

    expect(response.status).toBe(401);
    expect(fixture.events).toEqual([]);
  });

  it("accepts but ignores unsupported resources and actions", async () => {
    const fixture = routeFixture();

    const unsupportedResource = await fixture.route.handler(
      signedRequest(issueBody(), { event: "Comment" }),
    );
    const unsupportedAction = await fixture.route.handler(
      signedRequest(issueBody("update")),
    );

    expect(unsupportedResource.status).toBe(200);
    expect(unsupportedAction.status).toBe(200);
    expect(fixture.events).toEqual([]);
  });

  it("rejects malformed signed input", async () => {
    const fixture = routeFixture();

    const missingDelivery = await fixture.route.handler(
      signedRequest(issueBody(), { delivery: "" }),
    );
    const malformedJson = await fixture.route.handler(
      signedRawRequest("not-json"),
    );

    expect(missingDelivery.status).toBe(400);
    expect(malformedJson.status).toBe(400);
    expect(fixture.events).toEqual([]);
  });

  it("propagates publisher failures so Linear can retry", async () => {
    const route = createLinearWebhookRoute({
      resourceEvents: {
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
