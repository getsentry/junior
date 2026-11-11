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
import { getConversationStore } from "@/chat/db";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { readWalkthroughRun } from "@/chat/walkthroughs/generation";
import {
  walkthroughDocumentSchema,
  walkthroughOutputSchema,
} from "@/chat/walkthroughs/schema";
import {
  completeWalkthroughVersion,
  getWalkthroughVersion,
} from "@/chat/walkthroughs/store";

const sha = (digit: string) => digit.repeat(40);
const PATCH = [
  "@@ -1,2 +1,2 @@",
  " export const attempts = 1;",
  "-export const delayMs = 2;",
  "+export const delayMs = 3;",
].join("\n");

/** A code plugin with a two-layer stack whose top layer changes one file. */
function codePlugin() {
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
                headSha: sha("b"),
                additions: 1,
                deletions: 1,
              },
            ],
          };
        },
        async readDiff() {
          return {
            files: [{ path: "src/retry.ts", status: "modified", patch: PATCH }],
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
  await createApp({
    plugins: defineJuniorPlugins([codePlugin()]),
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
  return { app, fixture, get, post };
}

/** A stored document for a version of the one-layer stack. */
function readyDocument(versionId: string) {
  return walkthroughDocumentSchema.parse({
    schemaVersion: 1,
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
      diagram: {
        nodes: [{ id: "retry", label: "Retry", column: 0, row: 0 }],
        edges: [],
      },
      chapters: [
        {
          id: "change",
          type: "feature",
          slot: "change",
          caption: "The delay goes from 2 to 3.",
          body: "Retries wait longer.",
          asks: ["Why 3?"],
        },
      ],
    }),
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
    expect(tools.bash?.disabledReason).toBeDefined();
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
