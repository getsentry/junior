import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { createApp, defineJuniorPlugins } from "@/app";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  walkthroughDocumentSchema,
  walkthroughOutputSchema,
} from "@/chat/walkthroughs/schema";
import {
  completeWalkthroughVersion,
  failWalkthroughVersion,
  getWalkthroughVersion,
  readWalkthroughDocument,
  startWalkthroughVersion,
} from "@/chat/walkthroughs/store";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { closeConversationFixture } from "../fixtures/conversation";

const OWNER_EMAIL = "owner@example.com";
const codeChanges = [3087, 3088].map((number, index) => ({
  number,
  title: `PR ${number}`,
  body: "",
  url: `https://github.com/getsentry/junior/pull/${number}`,
  baseSha: "ab"[index]!.repeat(40),
  headSha: "bc"[index]!.repeat(40),
  additions: 1,
  deletions: 0,
}));

async function publicConversation(conversationId: string) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    actor: { email: OWNER_EMAIL },
    source: "web",
    visibility: "public",
  });
  return conversationId;
}

async function listedIds(): Promise<string[]> {
  const viewer = await resolveViewerUser(OWNER_EMAIL);
  if (!viewer) throw new Error("Missing test viewer");
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const feed = (await (await app.request("/api/conversations")).json()) as {
    conversations: Array<{ conversationId: string }>;
  };
  return feed.conversations.map((item) => item.conversationId);
}

function document(versionId: string) {
  return walkthroughDocumentSchema.parse({
    schemaVersion: 1,
    versionId,
    contentVersionId: versionId,
    repository: "getsentry/junior",
    layers: codeChanges.map(({ number, body: _body, ...layer }) => ({
      pr: number,
      ...layer,
    })),
    excerpts: [],
    skipped: [],
    checks: [],
    messages: [],
    content: walkthroughOutputSchema.parse({
      title: "Walkthroughs read code changes",
      intent: "This stack adds the Walkthrough format and provider reads.",
      diagram: {
        nodes: [{ id: "plugin", label: "Plugin", column: 0, row: 0 }],
        edges: [],
      },
      chapters: [
        {
          id: "change",
          type: "feature",
          slot: "change",
          caption: "Plugins read code changes.",
          body: "Core asks the plugin that owns the provider.",
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

describe("Walkthrough versions", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("reuses the live version of a snapshot and stores its document", async () => {
    const first = await publicConversation("local:web:walkthrough-gen-1");
    const second = await publicConversation("local:web:walkthrough-gen-2");
    const input = {
      provider: "github",
      repository: "getsentry/junior",
      codeChanges,
    };

    const started = await startWalkthroughVersion({
      ...input,
      generationConversationId: first,
    });
    expect(started.started).toBe(true);
    // A second click on the same commits joins the running version.
    const joined = await startWalkthroughVersion({
      ...input,
      generationConversationId: second,
    });
    expect(joined).toEqual({ version: started.version, started: false });

    const id = started.version.id;
    const storage = createMemoryAttachmentStorage();
    const stored = document(id);
    expect(
      await completeWalkthroughVersion(storage, {
        id,
        document: stored,
      }),
    ).toBe(true);
    const ready = await getWalkthroughVersion(id);
    expect(ready).toMatchObject({ status: "ready" });
    expect(await readWalkthroughDocument(storage, ready!)).toEqual(stored);
    expect([...storage.objects.keys()]).toEqual([`walkthroughs/${id}.json`]);

    // A finished version cannot fail or complete again.
    await failWalkthroughVersion({ id, reason: "late failure" });
    expect((await getWalkthroughVersion(id))?.status).toBe("ready");
  });

  it("lets a failed snapshot generate again", async () => {
    const first = await publicConversation("local:web:walkthrough-fail-1");
    const second = await publicConversation("local:web:walkthrough-fail-2");
    const input = {
      provider: "github",
      repository: "getsentry/junior",
      codeChanges: [codeChanges[0]!],
    };
    const failed = await startWalkthroughVersion({
      ...input,
      generationConversationId: first,
    });
    await failWalkthroughVersion({ id: failed.version.id, reason: "boom" });

    const retry = await startWalkthroughVersion({
      ...input,
      generationConversationId: second,
    });
    expect(retry.started).toBe(true);
    expect(retry.version.id).not.toBe(failed.version.id);
  });

  it("hides generation Conversations from Conversation lists", async () => {
    const generation = await publicConversation("local:web:walkthrough-hidden");
    const ordinary = await publicConversation("local:web:walkthrough-visible");
    expect(await listedIds()).toEqual(
      expect.arrayContaining([generation, ordinary]),
    );

    await startWalkthroughVersion({
      provider: "github",
      repository: "getsentry/junior",
      codeChanges: [codeChanges[1]!],
      generationConversationId: generation,
    });

    const listed = await listedIds();
    expect(listed).toContain(ordinary);
    expect(listed).not.toContain(generation);
  });
});

const RETRY_PATCH = [
  "@@ -1,2 +1,3 @@",
  " export const attempts = 1;",
  "-export const delayMs = 2;",
  "+export const delayMs = 3;",
  "+export const jitter = true;",
].join("\n");

/** A code plugin that serves one changed file and one unchanged caller. */
function codePlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "github",
      displayName: "GitHub",
      description: "Code changes for tests",
    },
    hooks: {
      codeChanges: {
        async readStack() {
          return undefined;
        },
        async readDiff() {
          return {
            files: [
              { path: "src/retry.ts", status: "modified", patch: RETRY_PATCH },
              {
                path: "pnpm-lock.yaml",
                status: "modified",
                patch: "@@ -1 +1 @@\n-a\n+b",
              },
            ],
          };
        },
        async readFile({ path }) {
          return path === "src/caller.ts"
            ? "import { delayMs } from './retry';\nwait(delayMs);\n"
            : undefined;
        },
      },
    },
  });
}

function submitOutput(seq: number) {
  return {
    title: "Retries wait longer",
    intent: "This PR changes the retry delay and adds jitter.",
    diagram: {
      nodes: [{ id: "retry", label: "Retry", column: 0, row: 0 }],
      edges: [],
    },
    chapters: [
      {
        id: "change",
        type: "feature",
        slot: "change",
        caption: "The delay grows and jitter is on.",
        body: "The delay goes from 2 to 3 [1] and the caller waits on it [2], as asked [3].",
        evidence: [
          { kind: "code", path: "src/retry.ts", pr: 3087, start: 2, end: 3 },
          { kind: "code", path: "src/caller.ts", pr: 3087, start: 2, end: 2 },
          { kind: "message", seq },
        ],
      },
    ],
  };
}

describe("submitWalkthrough", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("exists only in Walkthrough generation Turns and stores a checked document", async () => {
    await createApp({ plugins: defineJuniorPlugins([codePlugin()]) });
    const source = await publicConversation("local:web:walkthrough-source");
    const [message] = await getConversationEventStore().append(source, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "message",
          messageId: "ask",
          role: "user",
          text: "Make retries wait a bit longer, see https://sentry.io/issues/1/",
        },
      },
    ]);
    const generationId = await publicConversation("local:web:walkthrough-run");
    const layer = {
      ...codeChanges[0]!,
      title: "Retry",
      body: "",
      url: "https://github.com/getsentry/junior/pull/3087",
      additions: 2,
      deletions: 1,
    };
    const { version } = await startWalkthroughVersion({
      provider: "github",
      repository: "getsentry/junior",
      codeChanges: [codeChanges[0]!],
      generationConversationId: generationId,
      sourceConversationId: source,
    });
    const storage = createMemoryAttachmentStorage();
    const context = {
      conversationId: generationId,
      destination: { platform: "local" as const, conversationId: generationId },
      egress: { fetch: async () => new Response("ok") },
      source: createLocalSource(generationId),
      workspace: {} as ToolRuntimeContext["workspace"],
      attachmentStorage: storage,
      turnTools: turnBehavior({
        kind: "root",
        personInput: true,
        automationRun: false,
      }).tools,
    } satisfies ToolRuntimeContext;

    expect(createTools([], {}, context).submitWalkthrough).toBeUndefined();
    const tool = createTools(
      [],
      {},
      {
        ...context,
        turnTools: turnBehavior({
          kind: "root",
          personInput: false,
          automationRun: false,
          walkthroughGeneration: true,
        }).tools,
        walkthroughGeneration: {
          versionId: version.id,
          provider: "github",
          repository: "getsentry/junior",
          layers: [layer],
          sourceConversationId: source,
          modelId: "test-model",
        },
      },
    ).submitWalkthrough!;

    // A citation outside the hunk and the unchanged caller cannot resolve.
    const bad = submitOutput(message!.seq);
    bad.chapters[0]!.evidence[0] = {
      kind: "code",
      path: "src/retry.ts",
      pr: 3087,
      start: 9,
      end: 9,
    };
    await expect(
      tool.execute!(walkthroughOutputSchema.parse(bad), { toolCallId: "bad" }),
    ).rejects.toThrow(/problem/);
    expect((await getWalkthroughVersion(version.id))?.status).toBe(
      "generating",
    );

    await tool.execute!(
      walkthroughOutputSchema.parse(submitOutput(message!.seq)),
      {
        toolCallId: "good",
      },
    );
    const ready = await getWalkthroughVersion(version.id);
    expect(ready?.status).toBe("ready");
    const stored = await readWalkthroughDocument(storage, ready!);
    expect(stored?.skipped).toEqual([
      { reason: "lockfile", files: 1, lines: 2 },
    ]);
    expect(stored?.messages).toEqual([
      {
        seq: message!.seq,
        role: "user",
        text: "Make retries wait a bit longer, see https://sentry.io/issues/1/",
      },
    ]);
    expect(stored?.excerpts.map((excerpt) => excerpt.id)).toEqual([
      "3087:head:src/retry.ts#2-3",
      "3087:head:src/caller.ts#2-2",
    ]);
  });
});
