import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { createApp, defineJuniorPlugins } from "@/app";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { restoreSuiteExperimentalFeatures } from "../fixtures/experimental-setup";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../fixtures/conversation";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationStore, getDb } from "@/chat/db";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { readWalkthroughDiff } from "@/chat/walkthroughs/diff";
import { readWalkthroughRun } from "@/chat/walkthroughs/generation";
import {
  walkthroughDocumentSchema,
  walkthroughOutputSchema,
  walkthroughUpdateOutputSchema,
} from "@/chat/walkthroughs/schema";
import {
  completeWalkthroughVersion,
  getWalkthroughVersion,
  readWalkthroughDocument,
} from "@/chat/walkthroughs/store";
import { walkthroughFileHashes } from "@/chat/walkthroughs/update";
import { juniorWalkthroughVersions } from "@/db/schema";

const sha = (digit: string) => digit.repeat(40);
const PATCH = [
  "@@ -1,2 +1,2 @@",
  " export const attempts = 1;",
  "-export const delayMs = 2;",
  "+export const delayMs = 3;",
].join("\n");

/** The commit and patch the plugin serves; an update test pushes to them. */
type PluginState = { headSha: string; patch: string };

/** A code plugin with a one-layer stack that changes one file. */
function codePlugin(state: PluginState) {
  return defineJuniorPlugin({
    manifest: {
      name: "github",
      displayName: "GitHub",
      description: "Code changes for tests",
    },
    hooks: {
      codeChanges: {
        async readStack({ number }) {
          if (number !== 3088) return undefined;
          return {
            codeChanges: [
              {
                number: 3088,
                title: "Wait longer between retries",
                body: "Raises the delay.",
                url: "https://github.com/getsentry/junior/pull/3088",
                baseSha: sha("a"),
                headSha: state.headSha,
                additions: 1,
                deletions: 1,
              },
            ],
          };
        },
        async readDiff() {
          return {
            files: [
              { path: "src/retry.ts", status: "modified", patch: state.patch },
            ],
          };
        },
        async readFile({ path }) {
          return path === "src/caller.ts" ? "wait(delayMs);\n" : undefined;
        },
      },
    },
  });
}

async function setup(walkthroughs: boolean) {
  const state: PluginState = { headSha: sha("b"), patch: PATCH };
  await createApp({
    plugins: defineJuniorPlugins([codePlugin(state)]),
    experimental: { walkthroughs },
  });
  const fixture = await createConversationFixture();
  const viewer = await resolveViewerUser(fixture.actor.email!);
  if (!viewer) throw new Error("Missing test viewer");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  const post = (body: unknown) =>
    app.request("/api/walkthroughs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async (id: string) =>
    (await (await app.request(`/api/walkthroughs/${id}`)).json()) as {
      status: string;
      failureReason?: string;
    };
  return { app, fixture, get, post, state };
}

/** A stored document for a version of the one-layer stack. */
function readyDocument(versionId: string) {
  return walkthroughDocumentSchema.parse({
    schemaVersion: 2,
    versionId,
    contentVersionId: versionId,
    repository: "getsentry/junior",
    layers: [
      {
        pr: 3088,
        title: "Wait longer between retries",
        url: "https://github.com/getsentry/junior/pull/3088",
        baseSha: sha("a"),
        headSha: sha("b"),
        additions: 1,
        deletions: 1,
      },
    ],
    excerpts: [],
    skipped: [],
    checks: [],
    messages: [],
    content: walkthroughOutputSchema.parse({
      title: "Retries wait longer",
      intent: "This PR raises the retry delay.",
      diagrams: [
        {
          pr: 3088,
          nodes: [{ id: "retry", label: "Retry" }],
          edges: [],
        },
      ],
      chapters: [
        {
          id: "change",
          type: "feature",
          slot: "change",
          caption: "The delay goes from 2 to 3.",
          body: "Retries wait longer [1].",
          evidence: [
            { kind: "code", pr: 3088, path: "src/retry.ts", start: 2, end: 2 },
          ],
          decisions: [
            {
              id: "delay-ok",
              claim: "A 3 second delay is long enough.",
              origin: { kind: "not_asked" },
            },
          ],
          asks: ["Why 3?"],
        },
      ],
    }),
    files: walkthroughFileHashes(
      readWalkthroughDiff(3088, [
        { path: "src/retry.ts", status: "modified", patch: PATCH },
      ]).files,
    ),
    updates: [],
    meta: {
      modelId: "test-model",
      promptVersion: 1,
      createdAt: new Date().toISOString(),
    },
  });
}

const START = {
  provider: "github",
  repository: "getsentry/junior",
  number: 3088,
};

describe("Walkthrough generation", () => {
  afterEach(async () => {
    restoreSuiteExperimentalFeatures();
    await closeConversationFixture();
  });

  it("is not found while the experiment is off", async () => {
    const { post } = await setup(false);
    expect((await post(START)).status).toBe(404);
  });

  it("starts one generation per snapshot in a Conversation that lists hide", async () => {
    const { app, fixture, post } = await setup(true);

    expect((await post({ ...START, number: 1 })).status).toBe(404);
    expect((await post({ ...START, provider: "gitlab" })).status).toBe(404);
    const first = await post(START);
    expect(first.status).toBe(202);
    const started = (await first.json()) as { id: string; status: string };
    expect(started.status).toBe("generating");
    const again = (await (await post(START)).json()) as { id: string };
    expect(again.id).toBe(started.id);

    // One Turn is queued, and its Conversation stays out of the list.
    expect(fixture.queue.queuedMessages()).toHaveLength(1);
    const feed = (await (await app.request("/api/conversations")).json()) as {
      conversations: unknown[];
    };
    expect(feed.conversations).toEqual([]);

    // The Turn of that Conversation is a generation Turn for the version.
    const version = await getWalkthroughVersion(started.id);
    const run = await readWalkthroughRun(version!.generationConversationId!);
    expect(run?.generation).toMatchObject({
      versionId: started.id,
      repository: "getsentry/junior",
      layers: [{ number: 3088, headSha: sha("b") }],
    });
  });

  it("fails a version whose Turn ends without a Walkthrough, so a retry starts fresh", async () => {
    const { get, post } = await setup(true);
    const started = (await (await post(START)).json()) as { id: string };
    const version = await getWalkthroughVersion(started.id);
    const run = await readWalkthroughRun(version!.generationConversationId!);

    await run!.finish!();
    await expect(get(started.id)).resolves.toMatchObject({ status: "failed" });
    await expect(
      readWalkthroughRun(version!.generationConversationId!),
    ).resolves.toBeUndefined();

    const retry = (await (await post(START)).json()) as { id: string };
    expect(retry.id).not.toBe(started.id);
  });

  it("updates a ready version on new commits, keeping what did not change", async () => {
    const { app, fixture, post, state } = await setup(true);
    const storage = createMemoryAttachmentStorage();
    const first = (await (await post(START)).json()) as { id: string };
    await completeWalkthroughVersion(storage, {
      id: first.id,
      document: readyDocument(first.id),
    });
    // The first version quotes a source that is private now. The PR no
    // longer leads to it, but the update must keep its read check.
    const sourceId = "local:web:walkthrough-private-source";
    await getConversationStore().recordActivity({
      conversationId: sourceId,
      destination: { platform: "local", conversationId: sourceId },
      actor: { email: fixture.actor.email! },
      source: "web",
      visibility: "private",
    });
    await getDb()
      .update(juniorWalkthroughVersions)
      .set({ sourceConversationId: sourceId })
      .where(eq(juniorWalkthroughVersions.id, first.id));
    await app.request(`/api/walkthroughs/${first.id}/answers/delay-ok`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "change", note: "Make it 5." }),
    });

    // The same commits reuse the ready version. A push starts an update.
    expect(((await (await post(START)).json()) as { id: string }).id).toBe(
      first.id,
    );
    state.headSha = sha("c");
    state.patch = PATCH.replace("delayMs = 3", "delayMs = 5");
    const update = (await (await post(START)).json()) as { id: string };
    expect(update.id).not.toBe(first.id);
    const version = await getWalkthroughVersion(update.id);
    expect(version).toMatchObject({
      parentVersionId: first.id,
      sourceConversationId: sourceId,
    });
    const run = await readWalkthroughRun(version!.generationConversationId!);
    expect(run?.generation?.parentVersionId).toBe(first.id);

    const conversationId = version!.generationConversationId!;
    const tools = createTools([], {}, {
      conversationId,
      destination: { platform: "local", conversationId },
      egress: { fetch: async () => new Response("ok") },
      source: createLocalSource(conversationId),
      workspace: {} as ToolRuntimeContext["workspace"],
      attachmentStorage: storage,
      turnTools: turnBehavior({
        kind: "root",
        personInput: false,
        automationRun: false,
        walkthroughGeneration: true,
      }).tools,
      walkthroughGeneration: run!.generation!,
    } satisfies ToolRuntimeContext);
    await expect(
      tools.readPreviousWalkthrough!.execute!({}, { toolCallId: "read" }),
    ).resolves.toMatchObject({
      changed_files: [{ pr: 3088, path: "src/retry.ts" }],
      changed_chapters: ["change"],
      feedback_decisions: ["delay-ok"],
    });

    // The chapter whose code changed needs an item.
    const submit = tools.submitWalkthrough!;
    await expect(
      submit.execute!(walkthroughUpdateOutputSchema.parse({ items: [] }), {
        toolCallId: "empty",
      }),
    ).rejects.toThrow(/chapter change cites changed/);
    await submit.execute!(
      walkthroughUpdateOutputSchema.parse({
        items: [
          {
            id: "delay-five",
            touches: "change",
            answers: "delay-ok",
            caption: "The delay is now 5.",
            body: "The delay goes up to 5, as asked [1].",
            evidence: [
              {
                kind: "code",
                pr: 3088,
                path: "src/retry.ts",
                start: 2,
                end: 2,
              },
            ],
          },
        ],
      }),
      { toolCallId: "update" },
    );

    // The update keeps the story and adds what changed. The reviewer's
    // answer on the first version comes with the update, and both
    // versions are listed.
    const listed = (await (
      await app.request(`/api/walkthroughs/${update.id}`)
    ).json()) as {
      generationConversationId?: string;
      status: string;
      versions: Array<{ id: string }>;
    };
    expect(listed.status).toBe("ready");
    expect(listed.generationConversationId).toBe(
      (await getWalkthroughVersion(update.id))!.generationConversationId,
    );
    expect(listed.versions.map((v) => v.id)).toEqual([first.id, update.id]);
    const stored = await readWalkthroughDocument(
      storage,
      (await getWalkthroughVersion(update.id))!,
    );
    expect(stored).toMatchObject({
      parentVersionId: first.id,
      contentVersionId: first.id,
      content: { chapters: [{ id: "change" }] },
      updates: [
        {
          changedChapters: ["change"],
          items: [{ id: "delay-five", answers: "delay-ok" }],
        },
      ],
    });
    await expect(
      (await app.request(`/api/walkthroughs/${update.id}/answers`)).json(),
    ).resolves.toEqual({
      answers: [
        expect.objectContaining({
          decisionId: "delay-ok",
          versionId: first.id,
          value: "change",
        }),
      ],
    });
  });

  it("answers each reviewer's questions in one hidden, read-only Conversation", async () => {
    const { app, post } = await setup(true);
    const started = (await (await post(START)).json()) as { id: string };
    const questions = `/api/walkthroughs/${started.id}/questions`;
    const ask = (message: string, idempotencyKey: string) =>
      app.request(questions, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, idempotencyKey }),
      });

    // A generating version has no story to ask about yet.
    expect((await ask("Why 3?", "q0")).status).toBe(409);

    const storage = createMemoryAttachmentStorage();
    await completeWalkthroughVersion(storage, {
      id: started.id,
      document: readyDocument(started.id),
    });
    const first = await ask("Why 3?", "q1");
    expect(first.status).toBe(202);
    const { conversationId } = (await first.json()) as {
      conversationId: string;
    };
    const second = (await (await ask("Is 3 enough?", "q2")).json()) as {
      conversationId: string;
    };
    expect(second.conversationId).toBe(conversationId);
    expect(await (await app.request(questions)).json()).toEqual({
      conversationId,
    });
    expect(
      (await getConversationStore().get({ conversationId }))?.visibility,
    ).toBe("private");
    const feed = (await (await app.request("/api/conversations")).json()) as {
      conversations: unknown[];
    };
    expect(feed.conversations).toEqual([]);

    // Its Turns read the Walkthrough and its code, and nothing else runs.
    const run = await readWalkthroughRun(conversationId);
    expect(run).toEqual({
      questions: expect.objectContaining({ versionId: started.id }),
    });
    const tools = createTools([], {}, {
      conversationId,
      destination: { platform: "local", conversationId },
      egress: { fetch: async () => new Response("ok") },
      source: createLocalSource(conversationId),
      workspace: {} as ToolRuntimeContext["workspace"],
      attachmentStorage: storage,
      turnTools: turnBehavior({
        kind: "root",
        personInput: true,
        automationRun: false,
        walkthroughQuestions: true,
      }).tools,
      walkthroughQuestions: run!.questions!,
    } satisfies ToolRuntimeContext);
    expect(tools.bash?.disabledReason).toBeUndefined();
    expect(tools.writeFile?.disabledReason).toBeDefined();
    expect(tools.readWalkthrough?.disabledReason).toBeUndefined();
    await expect(
      tools.readWalkthrough!.execute!({}, { toolCallId: "doc" }),
    ).resolves.toMatchObject({
      walkthrough: { chapters: [{ id: "change", asks: ["Why 3?"] }] },
    });
    await expect(
      tools.readWalkthroughCode!.execute!(
        { pr: 3088, path: "src/caller.ts" },
        { toolCallId: "file" },
      ),
    ).resolves.toMatchObject({ text: "wait(delayMs);\n" });
    await expect(
      tools.readWalkthroughCode!.execute!({ pr: 1 }, { toolCallId: "other" }),
    ).rejects.toThrow(/not in this Walkthrough/);
  });
});
