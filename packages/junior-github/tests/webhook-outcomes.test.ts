import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceEvent } from "@sentry/junior-plugin-api";
import {
  createLocalPgliteFixture,
  type LocalPgliteFixture,
} from "@sentry/junior-testing/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubSqlSchema, juniorGitHubPullRequests } from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { buildGitHubOutcomeReport } from "../src/pull-request-outcomes/report";
import type { GitHubDb } from "../src/pull-request-outcomes/store";
import { createGitHubWebhookRoute } from "../src/webhooks/handler";
import { normalizeGitHubResourceEvents } from "../src/webhooks/resource-events";

const __dirname = dirname(fileURLToPath(import.meta.url));
type GitHubFixture = LocalPgliteFixture<GitHubDb>;

async function createGitHubFixture(): Promise<GitHubFixture> {
  const fixture = await createLocalPgliteFixture<GitHubDb>(githubSqlSchema);
  const migration = await readFile(
    resolve(__dirname, "../migrations/0000_pull_request_outcomes.sql"),
    "utf8",
  );
  await fixture.execute(migration);
  return fixture;
}

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    pull_request: {
      body: "Implemented by Junior\n\n<!-- junior-session-footer:start -->",
      closed_at: null,
      created_at: "2026-07-01T12:00:00.000Z",
      id: 1001,
      merged: false,
      merged_at: null,
      number: 946,
      updated_at: "2026-07-01T12:00:00.000Z",
      user: { login: "sentry-junior[bot]" },
    },
    repository: { full_name: "getsentry/junior", id: 2001 },
    ...overrides,
  };
}

function lifecyclePayload(input: {
  action?: "closed" | "opened" | "reopened";
  body?: string;
  closedAt?: string | null;
  createdAt: string;
  id: number;
  merged?: boolean;
  mergedAt?: string | null;
  number: number;
  updatedAt?: string;
  user?: string;
}) {
  return {
    action: input.action ?? "opened",
    pull_request: {
      body:
        input.body ??
        "Implemented by Junior\n\n<!-- junior-session-footer:start -->",
      closed_at: input.closedAt ?? null,
      created_at: input.createdAt,
      id: input.id,
      merged: input.merged ?? false,
      merged_at: input.mergedAt ?? null,
      number: input.number,
      updated_at: input.updatedAt ?? input.createdAt,
      user: { login: input.user ?? "sentry-junior[bot]" },
    },
    repository: { full_name: "getsentry/junior", id: 2001 },
  };
}

function signedRequest(body: unknown, eventName = "pull_request"): Request {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", "test-secret")
    .update(rawBody)
    .digest("hex")}`;
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

function webhookRoute(
  fixture: GitHubFixture,
  published: ResourceEvent[] = [],
  botEmail: () => string | undefined = () =>
    "264270552+sentry-junior[bot]@users.noreply.github.com",
) {
  return createGitHubWebhookRoute({
    botEmail,
    db: fixture.db(),
    resourceEvents: {
      async publish(event) {
        published.push(event);
      },
    },
    webhookSecret: () => "test-secret",
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GitHub webhook resource events", () => {
  it("uses the provider merge timestamp", () => {
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    const events = normalizeGitHubResourceEvents({
      body: {
        action: "closed",
        repository: { full_name: "getsentry/junior" },
        pull_request: {
          number: 946,
          merged: true,
          merged_at: "2026-07-10T12:00:00.000Z",
        },
      },
      deliveryId: "delivery-merge",
      eventName: "pull_request",
    });

    expect(events).toEqual([
      {
        eventKey: "github:delivery-merge:state.merged",
        eventType: "state.merged",
        occurredAtMs: Date.parse("2026-07-10T12:00:00.000Z"),
        provider: "github",
        resourceRef: "github:pull_request:getsentry/junior#946",
        terminal: true,
        trustedSummary: "GitHub PR getsentry/junior#946 was merged.",
      },
    ]);
  });

  it("normalizes review, comment, and check events into exact subscription contracts", () => {
    vi.setSystemTime(1_000);
    const cases = [
      {
        eventName: "pull_request_review",
        body: {
          action: "submitted",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 946 },
          review: {
            body: "please revise",
            state: "CHANGES_REQUESTED",
            user: { login: "reviewer" },
          },
        },
        expected: [
          {
            eventKey: "github:delivery-event:review.changes_requested",
            eventType: "review.changes_requested",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#946",
            trustedSummary:
              "GitHub PR getsentry/junior#946 received requested changes from reviewer.",
            untrustedText: "please revise",
          },
        ],
      },
      {
        eventName: "pull_request_review",
        body: {
          action: "submitted",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 946 },
          review: {
            body: "overall this looks close",
            state: "COMMENTED",
            user: { login: "reviewer" },
          },
        },
        expected: [
          {
            eventKey: "github:delivery-event:review.commented",
            eventType: "review.commented",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#946",
            trustedSummary:
              "GitHub PR getsentry/junior#946 received a review comment from reviewer.",
            untrustedText: "overall this looks close",
          },
        ],
      },
      {
        eventName: "issue_comment",
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          issue: { number: 946, pull_request: { url: "https://api.test/pr" } },
          comment: { body: "please revise", user: { login: "reviewer" } },
        },
        expected: [
          {
            eventKey: "github:delivery-event:comment.created",
            eventType: "comment.created",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#946",
            trustedSummary:
              "GitHub PR getsentry/junior#946 received a comment from reviewer.",
            untrustedText: "please revise",
          },
        ],
      },
      {
        eventName: "pull_request_review_comment",
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          pull_request: { number: 946 },
          comment: { body: "change this line", user: { login: "reviewer" } },
        },
        expected: [
          {
            eventKey: "github:delivery-event:review_comment.created",
            eventType: "review_comment.created",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#946",
            trustedSummary:
              "GitHub PR getsentry/junior#946 received an inline review comment from reviewer.",
            untrustedText: "change this line",
          },
        ],
      },
      {
        eventName: "check_suite",
        body: {
          action: "completed",
          repository: { full_name: "getsentry/junior" },
          check_suite: {
            conclusion: "failure",
            head_sha: "abcdef1234567890",
            pull_requests: [{ number: 946 }, { number: 947 }],
          },
        },
        expected: [
          {
            eventKey: "github:delivery-event:checks.failed:946",
            eventType: "checks.failed",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#946",
            trustedSummary:
              "GitHub PR getsentry/junior#946 checks failed for abcdef123456.",
          },
          {
            eventKey: "github:delivery-event:checks.failed:947",
            eventType: "checks.failed",
            occurredAtMs: 1_000,
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#947",
            trustedSummary:
              "GitHub PR getsentry/junior#947 checks failed for abcdef123456.",
          },
        ],
      },
    ];

    for (const testCase of cases) {
      expect(
        normalizeGitHubResourceEvents({
          body: testCase.body,
          deliveryId: "delivery-event",
          eventName: testCase.eventName,
        }),
      ).toEqual(testCase.expected);
    }
  });

  it("ignores comments on ordinary issues", () => {
    expect(
      normalizeGitHubResourceEvents({
        body: {
          action: "created",
          repository: { full_name: "getsentry/junior" },
          issue: { number: 946 },
          comment: { body: "ordinary issue", user: { login: "reviewer" } },
        },
        deliveryId: "delivery-issue-comment",
        eventName: "issue_comment",
      }),
    ).toEqual([]);
  });
});

describe("GitHub-owned pull request outcomes", () => {
  it("rejects unsigned deliveries before touching storage", async () => {
    const fixture = await createGitHubFixture();
    const published: ResourceEvent[] = [];
    try {
      const route = webhookRoute(fixture, published);
      const response = await route.handler(
        new Request("https://example.test/api/webhooks/github", {
          method: "POST",
          body: JSON.stringify(pullRequestPayload()),
        }),
      );
      expect(response.status).toBe(401);
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
      expect(published).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    "sentry-junior@example.com",
    "264270552+human@users.noreply.github.com",
  ])("fails an opening delivery for invalid bot email %s", async (botEmail) => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture, [], () => botEmail);

      await expect(
        route.handler(signedRequest(pullRequestPayload())),
      ).rejects.toThrow(
        "The configured GitHub App bot email must encode a [bot] login in GitHub's noreply format to classify pull request ownership",
      );
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects malformed terminal outcomes before persistence", async () => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const missingMergeTime = lifecyclePayload({
        action: "closed",
        closedAt: "2026-07-03T12:00:00.000Z",
        createdAt: "2026-07-01T12:00:00.000Z",
        id: 1001,
        merged: true,
        number: 946,
        updatedAt: "2026-07-03T12:00:00.000Z",
      });

      await expect(
        route.handler(signedRequest(missingMergeTime)),
      ).rejects.toThrow("GitHub pull request terminal timestamp is invalid");
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("derives ownership identity from the configured bot email environment", async () => {
    const fixture = await createGitHubFixture();
    vi.stubEnv(
      "CUSTOM_GITHUB_BOT_EMAIL",
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    try {
      const plugin = githubPlugin({
        botEmailEnv: "CUSTOM_GITHUB_BOT_EMAIL",
      });
      const [route] = plugin.hooks!.routes!({
        db: fixture.db(),
        log: { error() {}, info() {}, warn() {} },
        plugin: { name: "github" },
        resourceEvents: { async publish() {} },
      });

      expect(
        (await route!.handler(signedRequest(pullRequestPayload()))).status,
      ).toBe(202);
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([
        expect.objectContaining({ pullRequestId: "1001", state: "open" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("tracks one idempotent projection and ignores stale lifecycle events", async () => {
    const fixture = await createGitHubFixture();
    const published: ResourceEvent[] = [];
    try {
      const route = webhookRoute(fixture, published);
      const opened = pullRequestPayload();
      expect((await route.handler(signedRequest(opened))).status).toBe(202);
      expect((await route.handler(signedRequest(opened))).status).toBe(202);

      const merged = pullRequestPayload({
        action: "closed",
        pull_request: {
          ...(opened.pull_request as Record<string, unknown>),
          closed_at: "2026-07-03T12:00:00.000Z",
          merged: true,
          merged_at: "2026-07-03T12:00:00.000Z",
          updated_at: "2026-07-03T12:00:00.000Z",
        },
      });
      expect((await route.handler(signedRequest(merged))).status).toBe(202);

      const staleReopened = pullRequestPayload({
        action: "reopened",
        pull_request: {
          ...(opened.pull_request as Record<string, unknown>),
          body: "footer removed",
          updated_at: "2026-07-02T12:00:00.000Z",
        },
      });
      expect((await route.handler(signedRequest(staleReopened))).status).toBe(
        202,
      );

      const rows = await fixture.db().select().from(juniorGitHubPullRequests);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pullRequestId: "1001",
        repositoryFullName: "getsentry/junior",
        state: "merged",
      });
      expect(rows[0]?.updatedAt.toISOString()).toBe("2026-07-03T12:00:00.000Z");
      expect(published).toEqual([
        expect.objectContaining({ eventType: "state.merged" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a terminal outcome when its opening delivery arrives late", async () => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const opened = lifecyclePayload({
        createdAt: "2026-07-01T12:00:00.000Z",
        id: 1051,
        number: 949,
      });
      const merged = lifecyclePayload({
        action: "closed",
        closedAt: "2026-07-03T12:00:00.000Z",
        createdAt: "2026-07-01T12:00:00.000Z",
        id: 1051,
        merged: true,
        mergedAt: "2026-07-03T12:00:00.000Z",
        number: 949,
        updatedAt: "2026-07-03T12:00:00.000Z",
      });

      await route.handler(signedRequest(merged));
      await route.handler(signedRequest(opened));

      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([
        expect.objectContaining({
          pullRequestId: "1051",
          state: "merged",
          updatedAt: new Date("2026-07-03T12:00:00.000Z"),
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("reports open, merged, and unmerged outcomes across 7/30/90 days", async () => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const mergedOpen = lifecyclePayload({
        createdAt: "2026-05-01T12:00:00.000Z",
        id: 1101,
        number: 951,
      });
      const closedOpen = lifecyclePayload({
        createdAt: "2026-05-01T12:00:00.000Z",
        id: 1102,
        number: 952,
      });
      const oldOpen = lifecyclePayload({
        createdAt: "2026-05-01T12:00:00.000Z",
        id: 1103,
        number: 953,
      });
      const quarterlyOpen = lifecyclePayload({
        createdAt: "2026-05-20T12:00:00.000Z",
        id: 1104,
        number: 954,
      });
      const monthlyOpen = lifecyclePayload({
        createdAt: "2026-07-10T12:00:00.000Z",
        id: 1105,
        number: 955,
      });
      const recentOpen = lifecyclePayload({
        createdAt: "2026-07-29T12:00:00.000Z",
        id: 1106,
        number: 956,
      });
      await route.handler(signedRequest(mergedOpen));
      await route.handler(signedRequest(closedOpen));
      await route.handler(signedRequest(oldOpen));
      await route.handler(signedRequest(quarterlyOpen));
      await route.handler(signedRequest(monthlyOpen));
      await route.handler(signedRequest(recentOpen));
      await route.handler(
        signedRequest(
          lifecyclePayload({
            action: "closed",
            closedAt: "2026-07-30T12:00:00.000Z",
            createdAt: "2026-05-01T12:00:00.000Z",
            id: 1101,
            merged: true,
            mergedAt: "2026-07-30T12:00:00.000Z",
            number: 951,
            updatedAt: "2026-07-30T12:00:00.000Z",
          }),
        ),
      );
      await route.handler(
        signedRequest(
          lifecyclePayload({
            action: "closed",
            closedAt: "2026-07-15T12:00:00.000Z",
            createdAt: "2026-05-01T12:00:00.000Z",
            id: 1102,
            number: 952,
            updatedAt: "2026-07-15T12:00:00.000Z",
          }),
        ),
      );

      const rows = await fixture.db().select().from(juniorGitHubPullRequests);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pullRequestId: "1101",
            state: "merged",
          }),
          expect.objectContaining({
            pullRequestId: "1102",
            state: "closed_unmerged",
          }),
          expect.objectContaining({ pullRequestId: "1103", state: "open" }),
          expect.objectContaining({ pullRequestId: "1104", state: "open" }),
          expect.objectContaining({ pullRequestId: "1105", state: "open" }),
          expect.objectContaining({ pullRequestId: "1106", state: "open" }),
        ]),
      );

      const report = await buildGitHubOutcomeReport({
        db: fixture.db(),
        nowMs: Date.parse("2026-07-31T12:00:00.000Z"),
      });
      expect(report.title).toBe("GitHub work delivered");
      expect(report.metrics).toEqual([
        { label: "created · 30d", value: "2" },
        { label: "merged · 30d", tone: "good", value: "1" },
        { label: "closed unmerged · 30d", value: "1" },
        { label: "open now", value: "4" },
        { label: "merge rate · 30d", value: "50%" },
        { label: "median merge time · 30d", value: "90d" },
      ]);
      expect(report.recordSets?.[0]?.records).toEqual([
        {
          id: "7d",
          values: {
            closed: "0",
            created: "1",
            merged: "1",
            mergeRate: "100%",
            mergeTime: "90d",
            window: "7 days",
          },
        },
        {
          id: "30d",
          values: {
            closed: "1",
            created: "2",
            merged: "1",
            mergeRate: "50%",
            mergeTime: "90d",
            window: "30 days",
          },
        },
        {
          id: "90d",
          values: {
            closed: "1",
            created: "3",
            merged: "1",
            mergeRate: "50%",
            mergeTime: "90d",
            window: "90 days",
          },
        },
      ]);
      expect(report.recordSets?.[1]?.records?.[0]?.values).toEqual({
        closed: "1",
        created: "2",
        merged: "1",
        mergeRate: "50%",
        open: "4",
        repository: "getsentry/junior",
      });
    } finally {
      await fixture.close();
    }
  });

  it("reports zero outcomes without loading any pull request records", async () => {
    const fixture = await createGitHubFixture();
    try {
      const report = await buildGitHubOutcomeReport({
        db: fixture.db(),
        nowMs: Date.parse("2026-07-31T12:00:00.000Z"),
      });

      expect(report.metrics).toEqual([
        { label: "created · 30d", value: "0" },
        { label: "merged · 30d", tone: "neutral", value: "0" },
        { label: "closed unmerged · 30d", value: "0" },
        { label: "open now", value: "0" },
        { label: "merge rate · 30d", value: "—" },
        { label: "median merge time · 30d", value: "—" },
      ]);
      expect(report.recordSets?.[1]?.records).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    {
      label: "configured bot without the Junior footer",
      body: "ordinary bot pull request",
      user: "sentry-junior[bot]",
    },
    {
      label: "human author with the Junior footer",
      body: "<!-- junior-session-footer:start -->",
      user: "human",
    },
  ])("does not adopt $label", async ({ body, user }) => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const opened = lifecyclePayload({
        body,
        createdAt: "2026-07-01T12:00:00.000Z",
        id: 1201,
        number: 961,
        user,
      });

      expect((await route.handler(signedRequest(opened))).status).toBe(202);
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("does not adopt a human PR but still publishes its subscription event", async () => {
    const fixture = await createGitHubFixture();
    const published: ResourceEvent[] = [];
    try {
      const route = webhookRoute(fixture, published);
      const opened = pullRequestPayload();
      const closed = pullRequestPayload({
        action: "closed",
        pull_request: {
          ...(opened.pull_request as Record<string, unknown>),
          body: "human pull request",
          closed_at: "2026-07-03T12:00:00.000Z",
          updated_at: "2026-07-03T12:00:00.000Z",
          user: { login: "human" },
        },
      });

      expect((await route.handler(signedRequest(closed))).status).toBe(202);
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
      expect(published).toEqual([
        expect.objectContaining({ eventType: "state.closed_unmerged" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("does not classify ownership from a reopened event", async () => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const reopened = pullRequestPayload({ action: "reopened" });

      expect((await route.handler(signedRequest(reopened))).status).toBe(202);
      await expect(
        fixture.db().select().from(juniorGitHubPullRequests),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps tracking an owned PR after its footer is edited away", async () => {
    const fixture = await createGitHubFixture();
    try {
      const route = webhookRoute(fixture);
      const opened = pullRequestPayload();
      await route.handler(signedRequest(opened));
      const reopened = pullRequestPayload({
        action: "reopened",
        pull_request: {
          ...(opened.pull_request as Record<string, unknown>),
          body: "footer removed",
          updated_at: "2026-07-04T12:00:00.000Z",
        },
      });
      await route.handler(signedRequest(reopened));

      const [row] = await fixture.db().select().from(juniorGitHubPullRequests);
      expect(row?.state).toBe("open");
      expect(row?.updatedAt.toISOString()).toBe("2026-07-04T12:00:00.000Z");
    } finally {
      await fixture.close();
    }
  });
});
