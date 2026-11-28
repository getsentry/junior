import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../fixtures/conversation";
import {
  createGitHubApp,
  linkGitHubMember,
  sendGitHubWebhook,
  stubGitHubApp,
  viewerApi,
} from "../fixtures/github-objects";
import { createPluginTaskQueueTestAdapter } from "../fixtures/plugin-task-queue";
import {
  addPullRequestItem,
  api,
  conversation,
  PULL_REQUEST,
  ROOT,
  user,
} from "../fixtures/snoozes";
import { mswServer } from "../msw/server";

const TITLE = "Review acme entry";
const T0 = Date.parse("2026-01-02T03:00:00Z");

let app: Awaited<ReturnType<typeof createGitHubApp>>;
let fixture: ConversationFixture;
let tasks: ReturnType<typeof createPluginTaskQueueTestAdapter>;

/** The open pull request of `PULL_REQUEST` in a `pull_request` webhook. */
function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main" },
    closed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    draft: false,
    head: { ref: "feat/acme", sha: "aaa111" },
    html_url: PULL_REQUEST.url,
    id: 1000,
    mergeable: null,
    merged: false,
    merged_at: null,
    number: 1,
    state: "open",
    title: "Add acme entry",
    updated_at: new Date().toISOString(),
    user: { login: "byk" },
    ...overrides,
  };
}

/** Snooze the viewer's pull request item until one Event wakes it. */
async function snoozeUntil(eventType: string) {
  const ana = await user("ana@example.com");
  await addPullRequestItem(ROOT, [ana], TITLE);
  const asAna = api(fixture, ana);
  const snoozed = await asAna.snoozeOn({ conversationId: ROOT }, [
    { eventType, outcome: "wake" },
  ]);
  expect(snoozed.status).toBe(201);
  expect((await asAna.inbox()).inbox).toEqual([]);
  return asAna;
}

/**
 * Answer GraphQL reads of the pull request with `mergeable` at `head`: the
 * merge state patch after a push, and the card reads of a page.
 */
function stubMergeState(mergeable: string, head: string) {
  const node = {
    commits: { nodes: [] },
    headRefOid: head,
    mergeable,
    reviewRequests: { nodes: [] },
    updatedAt: new Date().toISOString(),
  };
  mswServer.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const { operationName } = (await request.json()) as {
        operationName: string;
      };
      const card = {
        ...node,
        additions: 1,
        author: { login: "byk" },
        baseRefName: "main",
        body: "",
        changedFiles: 1,
        deletions: 1,
        headRefName: "feat/acme",
        isDraft: false,
        merged: false,
        number: 1,
        state: "OPEN",
        title: "Add acme entry",
        url: PULL_REQUEST.url,
      };
      return HttpResponse.json({
        data: {
          p0: {
            pullRequest: operationName === "PullRequestHeadFacts" ? node : card,
          },
        },
      });
    }),
  );
}

/**
 * Comment on the pull request while GitHub reports `mergeable` for it. The
 * comment webhook carries no merge state, so the plugin reads it.
 */
async function comment(mergeable: boolean) {
  mswServer.use(
    http.get("https://api.github.com/repos/getsentry/junior/pulls/1", () =>
      HttpResponse.json(
        pullRequest({
          mergeable,
          mergeable_state: mergeable ? "clean" : "dirty",
        }),
      ),
    ),
  );
  await sendGitHubWebhook(app, "issue_comment", {
    action: "created",
    comment: { body: "Any update?", id: 4001, user: { login: "jane" } },
    sender: { id: 3001, login: "jane" },
    issue: {
      number: 1,
      pull_request: {
        url: "https://api.github.com/repos/getsentry/junior/pulls/1",
      },
    },
  });
}

/** Push `head` to the pull request, then run the patch task that reads it. */
async function push(head: string, mergeable: string) {
  stubMergeState(mergeable, head);
  await sendGitHubWebhook(app, "pull_request", {
    action: "synchronize",
    pull_request: pullRequest({ head: { ref: "feat/acme", sha: head } }),
  });
  vi.setSystemTime(Date.now() + 60_000);
  await tasks.deliver();
}

describe("GitHub pull request snoozes", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    fixture = await createConversationFixture();
    await conversation(ROOT, "public");
    stubGitHubApp();
    // Match data for an Event that a snooze wants reads the commits.
    mswServer.use(
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/1/commits",
        () => HttpResponse.json([]),
      ),
    );
    tasks = createPluginTaskQueueTestAdapter();
    app = await createGitHubApp({ pluginTaskQueue: tasks.pluginTaskQueue });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeConversationFixture();
  });

  it.each([
    {
      eventType: "pull_request.synchronized",
      phrase: "gets new commits",
      payload: { action: "synchronize", pull_request: pullRequest() },
    },
    {
      eventType: "pull_request.converted_to_draft",
      phrase: "is converted to a draft",
      payload: {
        action: "converted_to_draft",
        pull_request: pullRequest({ draft: true }),
      },
    },
    {
      eventType: "pull_request.reopened",
      phrase: "is reopened",
      payload: { action: "reopened", pull_request: pullRequest() },
    },
    {
      eventType: "pull_request.review_requested",
      phrase: "gets a review request",
      payload: {
        action: "review_requested",
        pull_request: pullRequest(),
        requested_reviewer: { login: "octo-reviewer" },
      },
    },
  ])(
    "wakes a snooze when the pull request $phrase",
    async ({ eventType, payload, phrase }) => {
      const asAna = await snoozeUntil(eventType);

      await sendGitHubWebhook(app, "pull_request", payload);

      expect((await asAna.inbox()).inbox).toEqual([TITLE]);
      expect(await asAna.wakes()).toEqual({
        [TITLE]: {
          eventType,
          kind: "event",
          phrase,
          resource: PULL_REQUEST.identifier,
        },
      });
    },
  );

  it("wakes a snooze when a push fixes a merge conflict that only the card showed", async () => {
    const asAna = await snoozeUntil("pull_request.merge_conflict.resolved");
    // A dashboard page reads the card, and GitHub reports the conflict
    // there. No webhook says so.
    stubMergeState("CONFLICTING", "aaa111");
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    expect(
      (await read(PULL_REQUEST.url)).objects.get(PULL_REQUEST.url)?.facts,
    ).toMatchObject({ mergeable: false });

    await push("bbb222", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
  });

  it("wakes a snooze when a push fixes a merge conflict that a comment found", async () => {
    const asAna = await snoozeUntil("pull_request.merge_conflict.resolved");

    await comment(false);
    expect((await asAna.inbox()).inbox).toEqual([]);

    await push("bbb222", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
  });

  it("reads an unchanged pull request again with its saved ETag, and a 304 keeps the merge conflict it found", async () => {
    const asAna = await snoozeUntil("pull_request.merge_conflict.resolved");
    const etag = 'W/"pull-1"';
    const answers: number[] = [];
    mswServer.use(
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/1",
        ({ request }) => {
          if (request.headers.get("if-none-match") === etag) {
            answers.push(304);
            return new HttpResponse(null, { headers: { etag }, status: 304 });
          }
          answers.push(200);
          return HttpResponse.json(
            pullRequest({ mergeable: false, mergeable_state: "dirty" }),
            { headers: { etag } },
          );
        },
      ),
    );
    for (const id of [4002, 4003]) {
      await sendGitHubWebhook(app, "issue_comment", {
        action: "created",
        comment: { body: "Any update?", id, user: { login: "jane" } },
        sender: { id: 3001, login: "jane" },
        issue: {
          number: 1,
          pull_request: {
            url: "https://api.github.com/repos/getsentry/junior/pulls/1",
          },
        },
      });
    }
    expect(answers).toEqual([200, 304]);
    expect((await asAna.inbox()).inbox).toEqual([]);

    await push("bbb222", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
  });

  it("wakes a snooze when a comment finds that the merge conflict is gone", async () => {
    const asAna = await snoozeUntil("pull_request.merge_conflict.resolved");
    await sendGitHubWebhook(app, "pull_request", {
      action: "labeled",
      pull_request: pullRequest({ mergeable: false }),
    });

    // A change on the base branch fixed it, with no push to the pull request.
    await comment(true);
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
  });

  it("does not wake a later snooze on a merge conflict fix that came before it", async () => {
    await sendGitHubWebhook(app, "pull_request", {
      action: "labeled",
      pull_request: pullRequest({ mergeable: false }),
    });
    const asAna = await snoozeUntil("pull_request.merge_conflict");
    // A change on the base branch fixed it. Only a conflict waiter reads.
    await comment(true);

    const resnoozed = await asAna.snoozeOn({ conversationId: ROOT }, [
      { eventType: "pull_request.merge_conflict.resolved", outcome: "wake" },
    ]);
    expect(resnoozed.status).toBe(201);
    await push("bbb222", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([]);
  });

  it("does not wake a snooze on a stale merge state read", async () => {
    const asAna = await snoozeUntil("pull_request.merge_conflict.resolved");
    await sendGitHubWebhook(app, "pull_request", {
      action: "labeled",
      pull_request: pullRequest({ mergeable: false }),
    });

    // The read of the first push comes after the second push, so the
    // entry rejects it, and the conflict stays marked.
    for (const head of ["bbb222", "ccc333"]) {
      await sendGitHubWebhook(app, "pull_request", {
        action: "synchronize",
        pull_request: pullRequest({ head: { ref: "feat/acme", sha: head } }),
      });
    }
    stubMergeState("MERGEABLE", "bbb222");
    vi.setSystemTime(Date.now() + 60_000);
    await tasks.deliver();
    expect((await asAna.inbox()).inbox).toEqual([]);

    await push("ddd444", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
  });

  it("wakes a snooze when a push fixes the merge conflict, and not before", async () => {
    const eventType = "pull_request.merge_conflict.resolved";
    const asAna = await snoozeUntil(eventType);

    // A push to a pull request that had no conflict sends nothing.
    await push("bbb222", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([]);

    // A `pull_request` webhook reports the conflict. A push that keeps it
    // sends nothing.
    await sendGitHubWebhook(app, "pull_request", {
      action: "labeled",
      pull_request: pullRequest({
        head: { ref: "feat/acme", sha: "bbb222" },
        mergeable: false,
      }),
    });
    await push("ccc333", "CONFLICTING");
    expect((await asAna.inbox()).inbox).toEqual([]);

    // The push that fixes it wakes the snooze once its merge state is read.
    await push("ddd444", "MERGEABLE");
    expect((await asAna.inbox()).inbox).toEqual([TITLE]);
    expect(await asAna.wakes()).toEqual({
      [TITLE]: {
        eventType,
        kind: "event",
        phrase: "no longer has a merge conflict",
        resource: PULL_REQUEST.identifier,
      },
    });
  });
});
