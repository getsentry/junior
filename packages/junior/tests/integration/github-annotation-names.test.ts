import path from "node:path";
import { githubPlugin } from "@sentry/junior-github";
import { and, asc, eq } from "drizzle-orm";
import { delay, http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { getPluginTools } from "@/chat/plugins/hooks/tools";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { juniorConversationAnnotations } from "@/db/schema";
import {
  prepareSlackParentConversation,
  slackDestination,
  slackSpawnInput,
  slackParentConversationId,
} from "../fixtures/child-agents";
import { sendGitHubWebhook, stubGitHubApp } from "../fixtures/github-objects";
import { createPluginTaskQueueTestAdapter } from "../fixtures/plugin-task-queue";
import { seedLinkedPerson } from "../fixtures/slack-user";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import { mswServer } from "../msw/server";

const API = "https://api.github.com";
const SECRET = "heartbeat-secret";
const person = slackSpawnInput.actor;
// The objects that one slice reads, as the GitHub plugin sets it.
const BATCH = 50;

let app: Awaited<ReturnType<typeof createApp>>;
let tasks: ReturnType<typeof createPluginTaskQueueTestAdapter>;
let waitUntil: ReturnType<typeof createWaitUntilCollector>;

async function createGitHubApp() {
  tasks = createPluginTaskQueueTestAdapter();
  waitUntil = createWaitUntilCollector();
  app = await createApp({
    plugins: defineJuniorPlugins([githubPlugin()]),
    pluginTaskQueue: tasks.pluginTaskQueue,
    waitUntil: waitUntil.fn,
  });
  await prepareSlackParentConversation();
  await migratePluginSchemas(getSqlExecutor(), [
    {
      dir: path.resolve(process.cwd(), "../junior-github/migrations"),
      pluginName: "github",
    },
  ]);
}

/** Run one heartbeat, then deliver the tasks that it started once. */
async function heartbeat(): Promise<number> {
  const response = await app.fetch(
    new Request("https://example.test/api/internal/heartbeat", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
  expect(response.status).toBe(202);
  await waitUntil.flush();
  return await tasks.deliver();
}

/** Add a public Conversation. */
async function conversation(id: string): Promise<string> {
  await getConversationStore().recordActivity({
    conversationId: id,
    destination: slackDestination,
    nowMs: 1_000,
    source: "slack",
    visibility: "public",
  });
  return id;
}

/**
 * Save an Annotation as an older release did: by its key and link, without
 * GitHub's id of the object.
 */
async function saveLegacyAnnotation(
  conversationId: string,
  row: {
    key: string;
    kind: "object" | "resource_link";
    objectType: "code_change" | "task";
    /** GitHub's id, which a later release saved. */
    subject?: { id: string; kind: "github:issue" | "github:pull_request" };
    url: string;
  },
): Promise<void> {
  await getDb()
    .insert(juniorConversationAnnotations)
    .values({
      annotation: { key: row.key, kind: row.kind, objectType: row.objectType },
      conversationId,
      createdAt: new Date(1_000),
      key: row.key,
      kind: row.kind,
      plugin: "github",
      ...(row.subject
        ? { subjectId: row.subject.id, subjectKind: row.subject.kind }
        : undefined),
      title: row.kind === "object" ? "Fix the flaky check" : null,
      updatedAt: new Date(1_000),
      url: row.url,
    });
}

async function annotationsOf(conversationId: string) {
  return await getDb()
    .select({
      action: juniorConversationAnnotations.action,
      key: juniorConversationAnnotations.key,
      subjectId: juniorConversationAnnotations.subjectId,
      subjectKind: juniorConversationAnnotations.subjectKind,
      url: juniorConversationAnnotations.url,
    })
    .from(juniorConversationAnnotations)
    .where(eq(juniorConversationAnnotations.conversationId, conversationId))
    .orderBy(asc(juniorConversationAnnotations.key));
}

async function conversationsFound(q: string): Promise<string[]> {
  return (await readConversationFeedFromSql({ q })).conversations.map(
    (row) => row.conversationId,
  );
}

/** Answer issue reads of one repository, and count them by number. */
function stubIssues(repo: string, idOf = (number: number) => number * 1000) {
  const reads = new Map<number, number>();
  mswServer.use(
    http.get(`${API}/repos/${repo}/issues/:number`, ({ params }) => {
      const number = Number(params["number"]);
      reads.set(number, (reads.get(number) ?? 0) + 1);
      return HttpResponse.json({
        html_url: `https://github.com/${repo}/issues/${number}`,
        id: idOf(number),
        number,
      });
    }),
  );
  return reads;
}

/** Run a GitHub tool in the person's Turn, with GitHub's answer. */
async function runTool(
  name: "github_createIssue" | "github_updateIssue",
  input: Record<string, unknown>,
  answer: Record<string, unknown>,
): Promise<void> {
  await getPluginTools({
    actor: person,
    conversationId: slackParentConversationId,
    destination: slackDestination,
    egress: {
      fetch: async () =>
        Response.json(
          { assignees: [], body: "", state: "open", title: "Fix", ...answer },
          { status: name === "github_createIssue" ? 201 : 200 },
        ),
    },
    resolveActorIdentity: async () => await readActorIdentity(person),
    source: { kind: "parent_message" },
    turnTools: turnBehavior({
      kind: "task",
      hasParent: true,
      personInput: false,
    }).tools,
    workspace: {} as never,
  })[name]!.execute!(input, { toolCallId: name });
}

describe("GitHub Annotations without GitHub's id of their object", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    stubGitHubApp();
    vi.stubEnv("JUNIOR_SCHEDULER_SECRET", SECRET);
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    await createGitHubApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await disconnectStateAdapter();
  });

  it("get the id and the current link of their issue or pull request, and a missing object stays as it is", async () => {
    const issue = await conversation("slack:C123:legacy-issue");
    const attached = await conversation("slack:C123:attached-pull");
    const missing = await conversation("slack:C123:missing-issue");
    await saveLegacyAnnotation(issue, {
      key: "getsentry/junior#12",
      kind: "object",
      objectType: "task",
      url: "https://github.com/getsentry/junior/issues/12",
    });
    await saveLegacyAnnotation(attached, {
      key: "getsentry/junior#77",
      kind: "resource_link",
      objectType: "code_change",
      url: "https://github.com/getsentry/junior/pull/77",
    });
    await saveLegacyAnnotation(missing, {
      key: "getsentry/junior#404",
      kind: "object",
      objectType: "task",
      url: "https://github.com/getsentry/junior/issues/404",
    });
    // A handler added later answers first.
    stubIssues("getsentry/junior");
    let missingReads = 0;
    mswServer.use(
      http.get(`${API}/repos/getsentry/junior/issues/404`, () => {
        missingReads += 1;
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }),
      http.get(`${API}/repos/getsentry/junior/pulls/77`, () =>
        HttpResponse.json({
          html_url: "https://github.com/getsentry/junior/pull/77",
          id: 77_000,
          number: 77,
        }),
      ),
    );

    await heartbeat();

    expect(await annotationsOf(issue)).toEqual([
      {
        action: "changed",
        key: "getsentry/junior#12",
        subjectId: "12000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/junior/issues/12",
      },
    ]);
    expect(await annotationsOf(attached)).toEqual([
      {
        action: "changed",
        key: "getsentry/junior#77",
        subjectId: "77000",
        subjectKind: "github:pull_request",
        url: "https://github.com/getsentry/junior/pull/77",
      },
    ]);
    expect(await annotationsOf(missing)).toEqual([
      {
        action: "changed",
        key: "getsentry/junior#404",
        subjectId: "https://github.com/getsentry/junior/issues/404",
        subjectKind: "link",
        url: "https://github.com/getsentry/junior/issues/404",
      },
    ]);
    // The job is done, so GitHub is not asked again.
    expect(await heartbeat()).toBe(0);
    expect(missingReads).toBe(1);
  });

  it("follow a rename that GitHub made before, so the new name finds the issue", async () => {
    const issue = await conversation("slack:C123:renamed-issue");
    await saveLegacyAnnotation(issue, {
      key: "getsentry/roach#5",
      kind: "object",
      objectType: "task",
      url: "https://github.com/getsentry/roach/issues/5",
    });
    // GitHub answers the old name with a redirect to the repository's id.
    const moved = (location: string) =>
      new HttpResponse(null, { headers: { location }, status: 301 });
    mswServer.use(
      http.get(`${API}/repos/getsentry/roach/issues/5`, () =>
        moved(`${API}/repositories/99/issues/5`),
      ),
      http.get(`${API}/repositories/99/issues/5`, () =>
        HttpResponse.json({
          html_url: "https://github.com/getsentry/cockroach/issues/5",
          id: 5_000,
          number: 5,
        }),
      ),
      http.get(`${API}/repos/getsentry/roach`, () =>
        moved(`${API}/repositories/99`),
      ),
      http.get(`${API}/repositories/99`, () =>
        HttpResponse.json({ full_name: "getsentry/cockroach", id: 99 }),
      ),
    );

    await heartbeat();

    expect(await annotationsOf(issue)).toEqual([
      expect.objectContaining({
        key: "getsentry/cockroach#5",
        subjectId: "5000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/cockroach/issues/5",
      }),
    ]);
    await expect(conversationsFound("getsentry/cockroach#5")).resolves.toEqual([
      issue,
    ]);
  });

  it("follow a chain of renames, so each issue stays on its own repository", async () => {
    // `getsentry/ant` is now `getsentry/bee`, and the repository that was
    // `getsentry/bee` is now `getsentry/cat`.
    const ant = await conversation("slack:C123:ant-issue");
    const bee = await conversation("slack:C123:bee-issue");
    for (const [id, repo] of [
      [ant, "getsentry/ant"],
      [bee, "getsentry/bee"],
    ] as const) {
      await saveLegacyAnnotation(id, {
        key: `${repo}#5`,
        kind: "object",
        objectType: "task",
        url: `https://github.com/${repo}/issues/5`,
      });
    }
    // The later rename is found last, so the moves run in the wrong order
    // unless they are ordered.
    for (const [from, to, id, wait] of [
      ["getsentry/ant", "getsentry/bee", 5_000, 0],
      ["getsentry/bee", "getsentry/cat", 6_000, 50],
    ] as const) {
      mswServer.use(
        http.get(`${API}/repos/${from}/issues/5`, async () => {
          await delay(wait);
          return HttpResponse.json({
            html_url: `https://github.com/${to}/issues/5`,
            id,
            number: 5,
          });
        }),
        http.get(`${API}/repos/${from}`, () =>
          HttpResponse.json({ full_name: to, id: id / 1000 }),
        ),
      );
    }

    await heartbeat();

    expect(await annotationsOf(ant)).toEqual([
      expect.objectContaining({ key: "getsentry/bee#5", subjectId: "5000" }),
    ]);
    expect(await annotationsOf(bee)).toEqual([
      expect.objectContaining({ key: "getsentry/cat#5", subjectId: "6000" }),
    ]);
  });

  it("sweep once an Annotation that has GitHub's id, so a rename before this release finds it by the new name", async () => {
    const issue = await conversation("slack:C123:renamed-named-issue");
    await saveLegacyAnnotation(issue, {
      key: "getsentry/roach#7",
      kind: "object",
      objectType: "task",
      subject: { id: "7000", kind: "github:issue" },
      url: "https://github.com/getsentry/roach/issues/7",
    });
    let reads = 0;
    const moved = (location: string) =>
      new HttpResponse(null, { headers: { location }, status: 301 });
    mswServer.use(
      http.get(`${API}/repos/getsentry/roach/issues/7`, () => {
        reads += 1;
        return moved(`${API}/repositories/99/issues/7`);
      }),
      http.get(`${API}/repositories/99/issues/7`, () =>
        HttpResponse.json({
          html_url: "https://github.com/getsentry/cockroach/issues/7",
          id: 7_000,
          number: 7,
        }),
      ),
      http.get(`${API}/repos/getsentry/roach`, () =>
        moved(`${API}/repositories/99`),
      ),
      http.get(`${API}/repositories/99`, () =>
        HttpResponse.json({ full_name: "getsentry/cockroach", id: 99 }),
      ),
    );

    await heartbeat();

    expect(await annotationsOf(issue)).toEqual([
      expect.objectContaining({
        key: "getsentry/cockroach#7",
        subjectId: "7000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/cockroach/issues/7",
      }),
    ]);
    await expect(conversationsFound("getsentry/cockroach#7")).resolves.toEqual([
      issue,
    ]);
    expect(await heartbeat()).toBe(0);
    expect(reads).toBe(1);
  });

  it("read at most one batch per slice, and the next slice reads on from the cursor", async () => {
    const ids: string[] = [];
    for (let number = 1; number <= BATCH + 1; number += 1) {
      const id = await conversation(`slack:C123:batch-${number}`);
      ids.push(id);
      await saveLegacyAnnotation(id, {
        key: `getsentry/junior#${number}`,
        kind: "object",
        objectType: "task",
        url: `https://github.com/getsentry/junior/issues/${number}`,
      });
    }
    const reads = stubIssues("getsentry/junior");
    const named = async () =>
      (
        await Promise.all(ids.map(async (id) => await annotationsOf(id)))
      ).filter(([row]) => row?.subjectKind === "github:issue").length;

    await heartbeat();
    expect(await named()).toBe(BATCH);

    await heartbeat();
    expect(await named()).toBe(BATCH + 1);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(await heartbeat()).toBe(0);
  });

  it("start over when a failed slice moved a repository, so the moved objects get names", async () => {
    for (let number = 1; number <= BATCH; number += 1) {
      await saveLegacyAnnotation(await conversation(`slack:C123:b-${number}`), {
        key: `getsentry/junior#${number}`,
        kind: "object",
        objectType: "task",
        url: `https://github.com/getsentry/junior/issues/${number}`,
      });
    }
    // `getsentry/zz` is now `getsentry/aa`, whose keys sort before the
    // cursor that the first slice leaves.
    const failing = await conversation("slack:C123:moved-failing");
    for (const [id, number] of [
      [await conversation("slack:C123:moved"), 1],
      [failing, 2],
    ] as const) {
      await saveLegacyAnnotation(id, {
        key: `getsentry/zz#${number}`,
        kind: "object",
        objectType: "task",
        url: `https://github.com/getsentry/zz/issues/${number}`,
      });
    }
    stubIssues("getsentry/junior");
    stubIssues("getsentry/aa");
    mswServer.use(
      http.get(`${API}/repos/getsentry/zz/issues/:number`, ({ params }) =>
        params["number"] === "1"
          ? HttpResponse.json({
              html_url: "https://github.com/getsentry/aa/issues/1",
              id: 1_000,
              number: 1,
            })
          : HttpResponse.json({ message: "Server Error" }, { status: 502 }),
      ),
      http.get(`${API}/repos/getsentry/zz`, () =>
        HttpResponse.json({ full_name: "getsentry/aa", id: 98 }),
      ),
    );

    await heartbeat();
    await heartbeat();
    while ((await tasks.deliver()) > 0);

    expect(await annotationsOf(failing)).toEqual([
      expect.objectContaining({
        key: "getsentry/aa#2",
        subjectId: "2000",
        subjectKind: "github:issue",
      }),
    ]);
  });

  it("leave an object that GitHub keeps failing to read after the last delivery", async () => {
    const issue = await conversation("slack:C123:failing-issue");
    await saveLegacyAnnotation(issue, {
      key: "getsentry/junior#500",
      kind: "object",
      objectType: "task",
      url: "https://github.com/getsentry/junior/issues/500",
    });
    let reads = 0;
    mswServer.use(
      http.get(`${API}/repos/getsentry/junior/issues/500`, () => {
        reads += 1;
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }),
    );

    await heartbeat();
    // The queue delivers the failed slice again, up to its last delivery.
    while ((await tasks.deliver()) > 0);

    expect(reads).toBe(5);
    expect(await annotationsOf(issue)).toEqual([
      expect.objectContaining({ subjectKind: "link" }),
    ]);
    expect(await heartbeat()).toBe(0);
  });
});

describe("a GitHub issue of a renamed repository", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    stubGitHubApp();
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    await createGitHubApp();
    await seedLinkedPerson({
      email: "pat@example.com",
      linked: { handle: "pat", provider: "github", subjectId: "2002" },
      slackUserId: person.userId,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await disconnectStateAdapter();
  });

  /** Create issue #4254 of `getsentry/junior` from the person's Turn. */
  async function createIssue(): Promise<void> {
    // The footer that links the issue to its Conversation needs a link.
    const previous = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      await runTool(
        "github_createIssue",
        {
          body: "Fix the flaky check.",
          repo: "getsentry/junior",
          title: "Fix the flaky check",
        },
        {
          html_url: "https://github.com/getsentry/junior/issues/4254",
          id: 4_254_000,
          number: 4254,
        },
      );
    } finally {
      setDashboardConversationLinkOptions(previous);
    }
  }

  it("is found by the new name and link after the rename and transfer webhooks", async () => {
    await createIssue();

    await sendGitHubWebhook(app, "repository", {
      action: "renamed",
      changes: { repository: { name: { from: "junior" } } },
      repository: {
        full_name: "getsentry/junior-next",
        id: 2001,
        name: "junior-next",
        owner: { login: "getsentry" },
      },
    });

    expect(await annotationsOf(slackParentConversationId)).toEqual([
      {
        action: "created",
        key: "getsentry/junior-next#4254",
        subjectId: "4254000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/junior-next/issues/4254",
      },
    ]);
    const [saved] = await getDb()
      .select({ annotation: juniorConversationAnnotations.annotation })
      .from(juniorConversationAnnotations)
      .where(
        eq(
          juniorConversationAnnotations.conversationId,
          slackParentConversationId,
        ),
      );
    expect(saved?.annotation).toMatchObject({
      key: "getsentry/junior-next#4254",
    });
    for (const q of [
      "getsentry/junior-next#4254",
      "https://github.com/getsentry/junior-next/issues/4254",
    ]) {
      await expect(conversationsFound(q)).resolves.toEqual([
        slackParentConversationId,
      ]);
    }

    // GitHub sends the side that the repository did not belong to as null.
    await sendGitHubWebhook(app, "repository", {
      action: "transferred",
      changes: {
        owner: { from: { organization: { login: "getsentry" }, user: null } },
      },
      repository: {
        full_name: "sentry-labs/junior-next",
        id: 2001,
        name: "junior-next",
        owner: { login: "sentry-labs" },
      },
    });

    expect(await annotationsOf(slackParentConversationId)).toEqual([
      expect.objectContaining({
        key: "sentry-labs/junior-next#4254",
        url: "https://github.com/sentry-labs/junior-next/issues/4254",
      }),
    ]);
  });

  it("keeps one Annotation when a tool changes the issue by its new name", async () => {
    await createIssue();

    await runTool(
      "github_updateIssue",
      { issue: 4254, repo: "getsentry/junior-next", state: "closed" },
      {
        html_url: "https://github.com/getsentry/junior-next/issues/4254",
        id: 4_254_000,
        number: 4254,
        state: "closed",
      },
    );

    expect(await annotationsOf(slackParentConversationId)).toEqual([
      {
        action: "created",
        key: "getsentry/junior-next#4254",
        subjectId: "4254000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/junior-next/issues/4254",
      },
    ]);
  });

  it("keeps another issue's Annotation when it already has the new name", async () => {
    await createIssue();
    // A stale Annotation of another issue still has the new key.
    await saveLegacyAnnotation(slackParentConversationId, {
      key: "getsentry/junior-next#4254",
      kind: "object",
      objectType: "task",
      subject: { id: "9999000", kind: "github:issue" },
      url: "https://github.com/getsentry/junior-next/issues/4254",
    });

    await runTool(
      "github_updateIssue",
      { issue: 4254, repo: "getsentry/junior-next", state: "closed" },
      {
        html_url: "https://github.com/getsentry/junior-next/issues/4254",
        id: 4_254_000,
        number: 4254,
        state: "closed",
      },
    );

    expect(await annotationsOf(slackParentConversationId)).toEqual([
      {
        action: "created",
        key: "getsentry/junior#4254",
        subjectId: "4254000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/junior-next/issues/4254",
      },
      expect.objectContaining({
        key: "getsentry/junior-next#4254",
        subjectId: "9999000",
      }),
    ]);

    // With no row of its own here, the issue takes its key's stale row as
    // a new Annotation: the other issue's time and created action go.
    await getDb()
      .update(juniorConversationAnnotations)
      .set({ action: "created" })
      .where(
        eq(juniorConversationAnnotations.key, "getsentry/junior-next#4254"),
      );
    await getDb()
      .delete(juniorConversationAnnotations)
      .where(
        and(
          eq(
            juniorConversationAnnotations.conversationId,
            slackParentConversationId,
          ),
          eq(juniorConversationAnnotations.key, "getsentry/junior#4254"),
        ),
      );
    await runTool(
      "github_updateIssue",
      { issue: 4254, repo: "getsentry/junior-next", state: "open" },
      {
        html_url: "https://github.com/getsentry/junior-next/issues/4254",
        id: 4_254_000,
        number: 4254,
        state: "open",
      },
    );
    expect(await annotationsOf(slackParentConversationId)).toEqual([
      expect.objectContaining({
        action: "changed",
        key: "getsentry/junior-next#4254",
        subjectId: "4254000",
      }),
    ]);
    const [taken] = await getDb()
      .select({ createdAt: juniorConversationAnnotations.createdAt })
      .from(juniorConversationAnnotations)
      .where(
        eq(juniorConversationAnnotations.key, "getsentry/junior-next#4254"),
      );
    expect(taken!.createdAt.getTime()).toBeGreaterThan(1_000);
  });

  it("stays on the new name when a tool changes the issue by its old name", async () => {
    await createIssue();
    await sendGitHubWebhook(app, "repository", {
      action: "renamed",
      changes: { repository: { name: { from: "junior" } } },
      repository: {
        full_name: "getsentry/junior-next",
        id: 2001,
        name: "junior-next",
        owner: { login: "getsentry" },
      },
    });

    // GitHub still answers the old name, from the new place.
    await runTool(
      "github_updateIssue",
      { issue: 4254, repo: "getsentry/junior", state: "closed" },
      {
        html_url: "https://github.com/getsentry/junior-next/issues/4254",
        id: 4_254_000,
        number: 4254,
        state: "closed",
      },
    );

    expect(await annotationsOf(slackParentConversationId)).toEqual([
      {
        action: "created",
        key: "getsentry/junior-next#4254",
        subjectId: "4254000",
        subjectKind: "github:issue",
        url: "https://github.com/getsentry/junior-next/issues/4254",
      },
    ]);
  });
});
