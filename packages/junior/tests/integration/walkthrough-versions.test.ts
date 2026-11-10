import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { getConversationStore } from "@/chat/db";
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
const codeChanges = [
  { number: 3087, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
  { number: 3088, baseSha: "b".repeat(40), headSha: "c".repeat(40) },
];

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
    layers: codeChanges.map((change) => ({
      pr: change.number,
      title: `PR ${change.number}`,
      url: `https://github.com/getsentry/junior/pull/${change.number}`,
      headSha: change.headSha,
      baseSha: change.baseSha,
      additions: 1,
      deletions: 0,
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
        costUsd: 1.25,
      }),
    ).toBe(true);
    const ready = await getWalkthroughVersion(id);
    expect(ready).toMatchObject({ status: "ready", costUsd: 1.25 });
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
