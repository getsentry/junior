import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequestRequesters } from "../src/db/schema";
import { recordJuniorPullRequest } from "./code-index";
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
      isDraft: false,
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
    await Promise.all(
      seeded(defaultRepository).map((change) =>
        recordJuniorPullRequest(fixture, {
          conversationIds: change.conversationIds,
          number: change.number,
          openedAt: change.openedAt,
          updatedAt: change.updatedAt,
        }),
      ),
    );
  });

  const defaultRepository = { name: "getsentry/junior", providerId: "1" };

  /** The open Junior pull requests before each test, in one repository. */
  function seeded(repository: { name: string; providerId: string }) {
    return (
      [
        [946, now - 2 * day],
        [947, now - 2 * day],
        [949, now - 2 * day],
        [951, now - 2 * day],
        // Its close webhook can still arrive.
        [950, now - 60_000],
      ] as const
    ).map(([number, updatedAt]) => ({
      conversationIds: ["slack:C1:1.0"],
      number,
      openedAt: new Date(now - 3 * day),
      providerId: `${number}0`,
      repository,
      state: "open" as const,
      updatedAt: new Date(updatedAt),
    }));
  }

  /** Move the seeded pull requests to another repository name or id. */
  function moveRepository(repository: { name: string; providerId: string }) {
    for (const change of seeded(repository)) fixture.codeIndex.seed(change);
  }

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Add a merge conflict notice for pull request 949. */
  async function noticeFor949(): Promise<void> {
    await fixture
      .db()
      .insert(juniorGitHubPullRequestRequesters)
      .values({
        conversationId: "slack:C1:1.0",
        createdAt: new Date(now - 3 * day),
        identityId: "identity-jane",
        number: 949,
        repositoryFullName: "getsentry/junior",
        updatedAt: new Date(now - 3 * day),
      });
    await h.inboxItems.forConversation("slack:C1:1.0").upsert({
      assigneeIdentityIds: ["identity-jane"],
      body: "Pull request 949 has merge conflicts.",
      dedupeKey: "merge-conflict:getsentry/junior#949",
      title: "Merge conflict · #949",
    });
  }

  it("records closes that GitHub did not deliver, once a day", async () => {
    await noticeFor949();
    await h.inboxItems.forConversation("slack:C1:1.0").upsert({
      assigneeIdentityIds: ["identity-jane"],
      body: "GitHub asks you to review #949.",
      dedupeKey: "pull-request-action:getsentry/junior#949",
      title: "Review requested · #949",
      waitsOnAssignees: true,
    });
    await h.heartbeat(now);
    // No webhook closes the ask after a missed close, so the close does.
    expect(h.closedNotices).toEqual([
      "merge-conflict:getsentry/junior#949",
      "pull-request-action:getsentry/junior#949",
    ]);
    // The chip and the ask change in one write.
    expect(h.batches).toContainEqual({
      annotations: [
        {
          conversationId: "slack:C1:1.0",
          upsert: expect.objectContaining({
            key: "getsentry/junior#949",
            status: "closed",
          }),
        },
      ],
      inboxItems: [
        "pull-request-action:getsentry/junior#949",
        "merge-conflict:getsentry/junior#949",
      ].map((dedupeKey) => ({
        close: {
          dedupeKey,
          reason: "The pull request closed without merging.",
          status: "dismissed",
        },
        conversationId: "slack:C1:1.0",
      })),
    });

    expect(queries.map((numbers) => numbers.sort())).toEqual([
      [946, 947, 949, 951],
    ]);
    expect(
      (await fixture.codeIndex.changes())
        .map((change) => [
          change.number,
          change.state,
          change.mergedAt ?? change.closedAt,
          change.conversationIds,
        ])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [946, "merged", new Date(now - day), ["slack:C1:1.0"]],
      [947, "open", undefined, ["slack:C1:1.0"]],
      [949, "closed", new Date(now - day), ["slack:C1:1.0"]],
      [950, "open", undefined, ["slack:C1:1.0"]],
      [951, "open", undefined, ["slack:C1:1.0"]],
    ]);
    // An open pull request keeps its state and gets its current title.
    expect(
      fixture.codeIndex.recorded
        .map((change) => [change.number, change.state, change.title])
        .sort(([a], [b]) => Number(a) - Number(b)),
    ).toEqual([
      [946, "merged", "Pull request 946"],
      [947, "open", "Pull request 947"],
      [949, "closed", "Pull request 949"],
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

  const states = async () =>
    (await fixture.codeIndex.changes())
      .map((change) => [change.number, change.state])
      .sort(([a], [b]) => Number(a) - Number(b));

  it("finds a renamed repository by its id", async () => {
    moveRepository({ name: "getsentry/junior-old", providerId: "1" });
    await h.heartbeat(now);

    expect(h.heartbeatLogs).toEqual([]);
    expect(await states()).toEqual([
      [946, "merged"],
      [947, "open"],
      [949, "closed"],
      [950, "open"],
      [951, "open"],
    ]);
  });

  it("repairs stored repository names from GitHub once", async () => {
    // A backfill kept the name from before the rename. GitHub no longer
    // finds repository 3.
    moveRepository({ name: "getsentry/junior-old", providerId: "1" });
    fixture.codeIndex.seed({
      conversationIds: [],
      number: 12,
      openedAt: new Date(now - 60_000),
      providerId: "120",
      repository: { name: "getsentry/gone", providerId: "3" },
      state: "open",
      updatedAt: new Date(now - 60_000),
    });
    mswServer.use(
      http.get("https://api.github.com/repositories/3", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const names = async () =>
      Object.fromEntries(
        (await fixture.codeIndex.changes()).map((change) => [
          change.number,
          change.repository.name,
        ]),
      );

    await h.heartbeat(now);
    // The reconcile leaves pull request 950, whose webhook can still arrive.
    expect((await names())[950]).toBe("getsentry/junior-old");
    await h.runStartedTasks();

    expect(h.heartbeatLogs).toEqual([]);
    expect(await names()).toEqual({
      12: "getsentry/gone",
      946: "getsentry/junior",
      947: "getsentry/junior",
      949: "getsentry/junior",
      950: "getsentry/junior",
      951: "getsentry/junior",
    });
    await h.heartbeat(now + day);
    expect(h.startedTasks).toEqual([]);
  });

  it("warns and keeps the code changes open when GitHub cannot reach the repository", async () => {
    moveRepository({ name: "getsentry/junior", providerId: "2" });
    await h.heartbeat(now);

    expect(h.heartbeatLogs).toEqual([
      ["warn", "GitHub pull request reconcile skipped a repository"],
    ]);
    expect(queries).toEqual([]);
    expect(new Set((await states()).map(([, state]) => state))).toEqual(
      new Set(["open"]),
    );
  });

  it("keeps a close open for the next reconcile when its notice close fails", async () => {
    await noticeFor949();
    const desk = h.inboxItems.forConversation("slack:C1:1.0");
    vi.spyOn(h.inboxItems, "forConversation").mockReturnValueOnce({
      ...desk,
      close: () => Promise.reject(new Error("The Inbox is down")),
    });
    await h.heartbeat(now);
    const state949 = async () =>
      (await fixture.codeIndex.changes()).find(
        (change) => change.number === 949,
      )?.state;
    expect(await state949()).toBe("open");
    expect(h.closedNotices).toEqual([]);

    vi.setSystemTime(now + day);
    await h.heartbeat(now + day);
    expect(await state949()).toBe("closed");
    expect(h.closedNotices).toEqual(["merge-conflict:getsentry/junior#949"]);
  });

  it("keeps a close open for the next reconcile when its event fails", async () => {
    vi.spyOn(h.events, "publish").mockRejectedValueOnce(
      new Error("The event queue is down"),
    );
    await h.heartbeat(now);
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
