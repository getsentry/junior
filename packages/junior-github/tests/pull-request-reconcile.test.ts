import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequests } from "../src/db/schema";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import {
  createPluginHarness,
  signedRequest,
  type PluginHarness,
} from "./plugin-harness";

describe("daily reconcile of open pull requests", () => {
  let fixture: GitHubFixture;
  let h: PluginHarness;
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const day = 24 * 60 * 60_000;
  let queries: number[][];
  let drafts: Set<number>;

  /** A pull request lifecycle as GitHub GraphQL returns it. */
  function lifecycle(number: number) {
    const closed = number === 946 || number === 949;
    const merged = number === 946;
    return {
      assignees: { nodes: [{ login: "octocat" }] },
      author: { __typename: "Bot", login: "sentry-junior" },
      closedAt: closed ? new Date(now - day).toISOString() : null,
      createdAt: new Date(now - 3 * day).toISOString(),
      databaseId: number * 10,
      headRefName: `feat/pr-${number}`,
      isDraft: drafts.has(number),
      merged,
      mergedAt: merged ? new Date(now - day).toISOString() : null,
      number,
      state: merged ? "MERGED" : closed ? "CLOSED" : "OPEN",
      title: `Pull request ${number}`,
      updatedAt: new Date(now - day).toISOString(),
    };
  }

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    h = createPluginHarness(fixture);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    vi.useFakeTimers({ now, toFake: ["Date"] });
    queries = [];
    drafts = new Set();
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "1234+sentry-junior[bot]@users.noreply.github.com",
    );
    mswServer.use(
      // GitHub finds a token's repositories by their current name or id.
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        async ({ request }) => {
          const body = (await request.json()) as {
            repositories?: string[];
            repository_ids?: number[];
          };
          const reachable =
            (body.repositories ?? []).every((name) => name === "junior") &&
            (body.repository_ids ?? []).every((id) => id === 1);
          return reachable
            ? HttpResponse.json({
                expires_at: "2027-01-01T00:00:00.000Z",
                token: "installation-token",
              })
            : HttpResponse.json(
                {
                  message:
                    "There is at least one repository that does not exist or is not accessible to the parent installation.",
                },
                { status: 422 },
              );
        },
      ),
      http.get("https://api.github.com/repositories/1", () =>
        HttpResponse.json({ full_name: "getsentry/junior", id: 1 }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946/commits",
        () =>
          HttpResponse.json([
            {
              author: { login: "jane" },
              commit: {
                message:
                  "Fix the close\n\nCo-authored-by: Sam <sam@example.com>",
              },
            },
          ]),
      ),
      http.post("https://api.github.com/graphql", async ({ request }) => {
        const { variables } = (await request.json()) as {
          variables: Record<string, unknown>;
        };
        const numbers = Object.entries(variables)
          .filter(([name]) => /^n\d+$/.test(name))
          .map(([, number]) => number as number);
        queries.push(numbers);
        return HttpResponse.json({
          data: {
            repository: {
              databaseId: 1,
              nameWithOwner: "getsentry/junior",
              ...Object.fromEntries(
                numbers.map((number, index) => [
                  `pr${index}`,
                  // GitHub deleted pull request 951.
                  number === 951 ? null : lifecycle(number),
                ]),
              ),
            },
          },
        });
      }),
    );
    const row = (number: number, updatedAt: number) => ({
      conversationIds: ["slack:C1:1.0"],
      number,
      openedAt: new Date(now - 3 * day),
      pullRequestId: `${number}0`,
      repositoryFullName: "getsentry/junior",
      repositoryId: "1",
      state: "open" as const,
      updatedAt: new Date(updatedAt),
    });
    await fixture
      .db()
      .insert(juniorGitHubPullRequests)
      .values([
        row(946, now - 2 * day),
        row(947, now - 2 * day),
        row(949, now - 2 * day),
        row(951, now - 2 * day),
        // Its close webhook can still arrive.
        row(950, now - 60_000),
      ]);
  });

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records closes that GitHub did not deliver, once a day", async () => {
    await h.heartbeat(now);

    expect(queries.map((numbers) => numbers.sort())).toEqual([
      [946, 947, 949, 951],
    ]);
    const rows = await fixture
      .db()
      .select()
      .from(juniorGitHubPullRequests)
      .orderBy(juniorGitHubPullRequests.number);
    expect(
      rows.map((row) => [row.number, row.state, row.mergedAt, row.closedAt]),
    ).toEqual([
      [946, "merged", new Date(now - day), new Date(now - day)],
      [947, "open", null, null],
      [949, "closed_unmerged", null, new Date(now - day)],
      [950, "open", null, null],
      [951, "open", null, null],
    ]);
    // An open pull request keeps its state and gets its current title.
    expect(
      h.codeChanges.map((change) => [
        change.number,
        change.state,
        change.title,
        change.conversationIds,
      ]),
    ).toEqual([
      [946, "merged", "Pull request 946", ["slack:C1:1.0"]],
      [947, "open", "Pull request 947", []],
      [949, "closed", "Pull request 949", ["slack:C1:1.0"]],
    ]);
    expect(
      h.annotations.map(({ annotation, conversationId }) => [
        conversationId,
        annotation.key,
        annotation.status,
      ]),
    ).toEqual([
      ["slack:C1:1.0", "getsentry/junior#946", "merged"],
      ["slack:C1:1.0", "getsentry/junior#949", "closed"],
    ]);

    vi.setSystemTime(now + 60_000);
    await h.heartbeat(now + 60_000);
    expect(queries).toHaveLength(1);
    // The next day, the row that waited for its webhook is checked too.
    vi.setSystemTime(now + day);
    await h.heartbeat(now + day);
    expect(queries[1]?.sort()).toEqual([947, 950, 951]);
  });

  it("writes a draft state that changed on GitHub", async () => {
    drafts = new Set([947]);
    await h.heartbeat(now);

    const [row] = await fixture
      .db()
      .select()
      .from(juniorGitHubPullRequests)
      .where(eq(juniorGitHubPullRequests.number, 947));
    expect(row).toMatchObject({ draft: true, state: "open" });
    expect(
      h.codeChanges.map((change) => [
        change.number,
        change.state,
        change.draft,
      ]),
    ).toEqual([
      [946, "merged", undefined],
      [947, "open", true],
      [949, "closed", undefined],
    ]);
  });

  it("publishes a corrected close with the key of its webhook", async () => {
    const closes = () =>
      h.published.filter(
        (event) =>
          event.identifier === "getsentry/junior#946" &&
          event.eventType === "pull_request.merged",
      );
    await h.heartbeat(now);
    expect(closes()).toEqual([
      expect.objectContaining({
        data: {
          headBranch: "feat/pr-946",
          isDraft: false,
          openerUsername: "sentry-junior[bot]",
          pullRequest: 946,
          repo: "getsentry/junior",
        },
        objectType: "code_change",
        occurredAtMs: now - day,
        people: [
          { handle: "octocat", provider: "github" },
          { handle: "jane", provider: "github" },
          { email: "sam@example.com" },
        ],
        terminal: true,
        trustedSummary: "GitHub PR getsentry/junior#946 was merged.",
      }),
    ]);
    expect(
      h.published.filter(
        (event) => event.eventType === "pull_request.closed_unmerged",
      ),
    ).toHaveLength(2);

    // The late webhook has the same key, so a Watch gets the merge once.
    const merged = lifecycle(946);
    await h.deliver(
      signedRequest({
        deliveryId: "delivery-merge",
        eventName: "pull_request",
        body: {
          action: "closed",
          installation: { id: 456 },
          pull_request: {
            assignees: [{ login: "octocat" }],
            closed_at: merged.closedAt,
            created_at: merged.createdAt,
            id: merged.databaseId,
            merged: true,
            merged_at: merged.mergedAt,
            number: 946,
            updated_at: merged.updatedAt,
            user: { login: "sentry-junior[bot]" },
          },
          repository: { full_name: "getsentry/junior", id: 1 },
          sender: { login: "jane" },
        },
      }),
    );
    expect(closes()).toHaveLength(2);
    const [reconciled, webhook] = closes();
    expect(reconciled?.eventKey).toBe(webhook?.eventKey);
    expect(reconciled?.people).toEqual(webhook?.people);
  });

  const rowStates = async () =>
    (
      await fixture
        .db()
        .select()
        .from(juniorGitHubPullRequests)
        .orderBy(juniorGitHubPullRequests.number)
    ).map((row) => [row.number, row.state]);

  it("finds a renamed repository by its id", async () => {
    await fixture
      .db()
      .update(juniorGitHubPullRequests)
      .set({ repositoryFullName: "getsentry/junior-old" });
    await h.heartbeat(now);

    expect(h.heartbeatLogs).toEqual([]);
    expect(await rowStates()).toEqual([
      [946, "merged"],
      [947, "open"],
      [949, "closed_unmerged"],
      [950, "open"],
      [951, "open"],
    ]);
  });

  it("warns and keeps the rows when GitHub cannot reach the repository", async () => {
    await fixture
      .db()
      .update(juniorGitHubPullRequests)
      .set({ repositoryId: "2" });
    await h.heartbeat(now);

    expect(h.heartbeatLogs).toEqual([
      ["warn", "GitHub pull request reconcile skipped a repository"],
    ]);
    expect(queries).toEqual([]);
    expect(new Set((await rowStates()).map(([, state]) => state))).toEqual(
      new Set(["open"]),
    );
  });

  it("keeps a close open for the next reconcile when its event fails", async () => {
    vi.spyOn(h.events, "publish").mockRejectedValueOnce(
      new Error("The event queue is down"),
    );
    await h.heartbeat(now);
    const states = async () =>
      (
        await fixture
          .db()
          .select()
          .from(juniorGitHubPullRequests)
          .orderBy(juniorGitHubPullRequests.number)
      ).map((row) => [row.number, row.state]);
    expect(await states()).toContainEqual([946, "open"]);

    vi.setSystemTime(now + day);
    await h.heartbeat(now + day);
    expect(await states()).toContainEqual([946, "merged"]);
    expect(
      h.published.filter(
        (event) =>
          event.identifier === "getsentry/junior#946" &&
          event.eventType === "pull_request.merged",
      ),
    ).toHaveLength(1);
  });
});
