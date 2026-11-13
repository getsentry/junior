import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  eventMatches,
  type EventInput,
  type EventMatch,
  type EventPublisher,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "../src/index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";

/** One check suite in the commit check-suites list. */
interface Suite {
  conclusion: string | null;
  id: number;
  latest_check_runs_count: number;
  status: string;
}

/** A signed `check_suite.completed` delivery for pull request 946. */
function suiteCompleted(deliveryId: string, suiteId: number): Request {
  const body = JSON.stringify({
    action: "completed",
    installation: { id: 456 },
    check_suite: {
      app: { name: "GitHub Actions", slug: "github-actions" },
      conclusion: "success",
      head_branch: "feat/green",
      head_sha: HEAD_SHA,
      id: suiteId,
      latest_check_runs_count: 3,
      pull_requests: [
        {
          base: { repo: { id: 2001, name: "junior", url: "u" } },
          head: {
            ref: "feat/green",
            repo: { id: 2001, name: "junior", url: "u" },
            sha: HEAD_SHA,
          },
          number: 946,
        },
      ],
    },
    repository: {
      full_name: "getsentry/junior",
      id: 2001,
      name: "junior",
      owner: { login: "getsentry" },
    },
  });
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "check_suite",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

describe("pull_request.checks.passed on check suite webhooks", () => {
  let fixture: GitHubFixture;
  let suites: Suite[];
  let suiteReads: number;
  let pullRequestReads: number;
  let published: EventInput[];
  /** Events that a deduping consumer, like core, delivers once per key. */
  let delivered: Map<string, EventInput>;
  /** One Watch on pull request 946. */
  let watch: { events: string[]; match?: EventMatch };

  const watches = (event: EventInput) =>
    event.identifier === "getsentry/junior#946" &&
    watch.events.includes(event.eventType) &&
    eventMatches(watch.match, event.data);

  const events: EventPublisher = {
    async hasMatch(candidates) {
      return candidates.some(watches);
    },
    async neededMatchKeys(input) {
      const watched =
        input.identifiers.includes("getsentry/junior#946") &&
        input.eventTypes.some((type) => watch.events.includes(type));
      return watched ? Object.keys(watch.match ?? {}) : [];
    },
    async publish(event) {
      published.push(event);
      // Core delivers one Event key once to each Watch.
      if (!watches(event)) return;
      const key = `${event.identifier}\0${event.eventKey}`;
      if (!delivered.has(key)) delivered.set(key, event);
    },
  };

  async function deliver(deliveryId: string, suiteId: number): Promise<void> {
    const [route] = githubPlugin().hooks!.routes!({
      annotations: {
        forConversation() {
          return {
            async upsert() {},
            async remove() {},
            async list() {
              return [];
            },
          };
        },
      },
      cache: {
        async getOrLoad(_key, load) {
          return (await load()).value;
        },
      },
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record() {},
      },
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      users: {
        async readIdentity() {
          return undefined;
        },
      },
    });
    const response = await route!.handler(suiteCompleted(deliveryId, suiteId));
    expect(response.status).toBe(202);
  }

  const publishedTypes = () => published.map((event) => event.eventType);
  const passed = () =>
    [...delivered.values()].filter(
      (event) => event.eventType === "pull_request.checks.passed",
    );

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    suiteReads = 0;
    pullRequestReads = 0;
    published = [];
    delivered = new Map();
    watch = {
      events: ["pull_request.checks.passed", "pull_request.checks.recovered"],
    };
    suites = [
      {
        conclusion: "success",
        id: 1,
        latest_check_runs_count: 4,
        status: "completed",
      },
      {
        conclusion: "neutral",
        id: 2,
        latest_check_runs_count: 1,
        status: "completed",
      },
      {
        conclusion: "skipped",
        id: 3,
        latest_check_runs_count: 1,
        status: "completed",
      },
      // GitHub makes a suite for each app that can write checks. One that
      // never adds a check run stays queued.
      {
        conclusion: null,
        id: 4,
        latest_check_runs_count: 0,
        status: "queued",
      },
    ];
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    mswServer.use(
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: "2027-01-01T00:00:00.000Z",
            token: "installation-token",
          }),
      ),
      http.get(
        `https://api.github.com/repos/getsentry/junior/commits/${HEAD_SHA}/check-suites`,
        () => {
          suiteReads += 1;
          return HttpResponse.json({
            check_suites: suites,
            total_count: suites.length,
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946",
        () => {
          pullRequestReads += 1;
          return HttpResponse.json({
            draft: false,
            user: { login: "octocat" },
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946/commits",
        () => HttpResponse.json([]),
      ),
    );
  });

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
  });

  it("publishes checks.passed when the last suite passes and the others are green", async () => {
    await deliver("delivery-last", 1);

    expect(suiteReads).toBe(1);
    expect(publishedTypes()).toEqual([
      "pull_request.checks.recovered",
      "pull_request.checks.recovered",
      "pull_request.checks.passed",
      "pull_request.checks.passed",
    ]);
    expect(passed()).toEqual([
      expect.objectContaining({
        eventKey: `github:pull_request.checks.passed:getsentry/junior#946:${HEAD_SHA}`,
        identifier: "getsentry/junior#946",
        objectType: "code_change",
        trustedSummary: `GitHub PR getsentry/junior#946 all check suites passed for ${HEAD_SHA.slice(0, 12)} on feat/green.`,
        data: expect.objectContaining({
          checkSuiteId: 1,
          commitSha: HEAD_SHA,
          headBranch: "feat/green",
          pullRequest: 946,
          repo: "getsentry/junior",
          suiteConclusion: "success",
        }),
      }),
    ]);
    // The repository copy shares the key, so a broad trigger runs once.
    expect(
      published
        .filter((event) => event.eventType === "pull_request.checks.passed")
        .map((event) => [event.identifier, event.eventKey]),
    ).toEqual([
      [
        "getsentry/junior#946",
        `github:pull_request.checks.passed:getsentry/junior#946:${HEAD_SHA}`,
      ],
      [
        "getsentry/junior",
        `github:pull_request.checks.passed:getsentry/junior#946:${HEAD_SHA}`,
      ],
    ]);
  });

  it("publishes only checks.recovered while another suite is pending", async () => {
    suites[1] = { ...suites[1]!, conclusion: null, status: "in_progress" };

    await deliver("delivery-pending", 1);

    expect(suiteReads).toBe(1);
    expect(publishedTypes()).toEqual([
      "pull_request.checks.recovered",
      "pull_request.checks.recovered",
    ]);
  });

  it("does not publish checks.passed when another suite failed", async () => {
    suites[2] = { ...suites[2]!, conclusion: "failure" };

    await deliver("delivery-failed", 1);

    expect(suiteReads).toBe(1);
    expect(publishedTypes()).not.toContain("pull_request.checks.passed");
  });

  it("does not read the suites when nothing matches checks.passed", async () => {
    watch = { events: ["pull_request.checks.recovered"] };
    await deliver("delivery-recovered-only", 1);

    watch = { events: ["pull_request.checks.failed"] };
    await deliver("delivery-unwatched", 1);

    expect(suiteReads).toBe(0);
    expect(publishedTypes()).not.toContain("pull_request.checks.passed");

    // A Watch on checks.passed makes the same suite read the others.
    watch = { events: ["pull_request.checks.passed"] };
    await deliver("delivery-passed-watched", 1);

    expect(suiteReads).toBe(1);
    expect(passed()).toHaveLength(1);
  });

  it("reads the suites when a checks.passed filter needs a value that loads later", async () => {
    watch = {
      events: ["pull_request.checks.passed"],
      match: { isDraft: false },
    };

    await deliver("delivery-filtered", 1);

    expect(pullRequestReads).toBe(1);
    expect(suiteReads).toBe(1);
    expect(passed()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ isDraft: false }),
        eventType: "pull_request.checks.passed",
      }),
    ]);
  });

  it("delivers checks.passed once per head commit when two suites finish green", async () => {
    await deliver("delivery-first", 1);
    await deliver("delivery-second", 2);

    expect(suiteReads).toBe(2);
    expect(
      publishedTypes().filter((type) => type === "pull_request.checks.passed"),
    ).toHaveLength(4);
    expect(passed()).toHaveLength(1);
    expect(
      [...delivered.values()].filter(
        (event) => event.eventType === "pull_request.checks.recovered",
      ),
    ).toHaveLength(2);
  });
});
