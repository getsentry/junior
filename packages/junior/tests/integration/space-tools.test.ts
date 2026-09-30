import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { createSpaceBackfillTools } from "@/chat/spaces/backfill-tool";
import { setSpacesConfig } from "@/chat/spaces/registration";
import { createSpaceTools } from "@/chat/spaces/tools";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { juniorSpaceChanges, juniorSpaces } from "@/db/schema";
import { conversationBriefFixture } from "../fixtures/conversation-brief";
import { SUITE_EXPERIMENTAL } from "../fixtures/experimental-setup";

const CURRENT = "local:spaces:current";
const PUBLIC_OTHER = "local:spaces:public-other";
const PRIVATE_OTHER = "local:spaces:private-other";

function context(
  conversationPrivacy: ToolRuntimeContext["conversationPrivacy"] = "public",
): ToolRuntimeContext {
  return {
    conversationId: CURRENT,
    conversationPrivacy,
    destination: { platform: "local", conversationId: CURRENT },
    source: createLocalSource(CURRENT),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

async function run(
  tools: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<any> {
  const tool = tools[name];
  if (!tool?.execute || !tool.prepareArguments) {
    throw new Error(`${name} is missing`);
  }
  return await tool.execute(tool.prepareArguments(input), {});
}

async function recordConversation(
  conversationId: string,
  visibility: "public" | "private",
  nowMs: number,
) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs,
    source: "local",
    title: `Title ${conversationId}`,
    visibility,
  });
  await appendConversationBrief(getDb(), {
    conversationId,
    turnId: "turn-1",
    throughSeq: 1,
    content: conversationBriefFixture({
      summary: `Summary ${conversationId}`,
    }),
    searchText: "summary",
    modelId: "test-model",
  });
}

describe("Space tools", () => {
  beforeEach(() => {
    setSpacesConfig({ enabled: true });
  });

  afterEach(async () => {
    setSpacesConfig(undefined);
    await closeDb();
  });

  it("exist in every Conversation and vanish when disabled", () => {
    // A person can reorganize Spaces from a private Conversation too.
    const privateTools = Object.keys(createSpaceTools(context("private")));
    expect(privateTools).toEqual(Object.keys(createSpaceTools(context())));
    expect(privateTools).toEqual(
      expect.arrayContaining([
        "createSpace",
        "updateSpace",
        "findSpaceConversations",
        "assignConversationSpace",
      ]),
    );

    // The backfill runs only for operators, and never in public Conversations.
    expect(createSpaceBackfillTools(context("private"))).toEqual({});
    setExperimentalFeatures({ ...SUITE_EXPERIMENTAL, "operator-tools": true });
    expect(Object.keys(createSpaceBackfillTools(context("private")))).toEqual([
      "runSpaceBackfill",
    ]);
    expect(createSpaceBackfillTools(context("public"))).toEqual({});

    setSpacesConfig(undefined);
    expect(createSpaceTools(context())).toEqual({});
    expect(createSpaceBackfillTools(context("private"))).toEqual({});
  });

  it("build, reorganize, and browse a nested Space tree", async () => {
    await recordConversation(CURRENT, "public", 1_000);
    await recordConversation(PUBLIC_OTHER, "public", 2_000);
    await recordConversation(PRIVATE_OTHER, "private", 3_000);
    const tools = createSpaceTools(context());

    const sdks = (
      await run(tools, "createSpace", {
        name: "SDKs",
        description: "Client SDK work.",
        reason: "Group SDK work.",
      })
    ).space;
    const javascript = (
      await run(tools, "createSpace", {
        name: "JavaScript",
        description: "The JavaScript SDK.",
        parent_space_id: sdks.space_id,
      })
    ).space;
    const cloudflare = (
      await run(tools, "createSpace", {
        name: "Cloudflare",
        description: "Cloudflare Workers support.",
        parent_space_id: sdks.space_id,
      })
    ).space;
    expect(cloudflare.path).toBe("SDKs › Cloudflare");
    await expect(
      run(tools, "createSpace", {
        name: "javascript",
        description: "Duplicate.",
        parent_space_id: sdks.space_id,
      }),
    ).rejects.toThrow('A Space named "JavaScript" already exists here');

    // Moving a Space moves its subtree and every assigned Conversation.
    await run(tools, "assignConversationSpace", {
      space_id: cloudflare.space_id,
    });
    await run(tools, "assignConversationSpace", {
      space_id: cloudflare.space_id,
      conversation_ids: [PUBLIC_OTHER, PRIVATE_OTHER],
    });
    const moved = (
      await run(tools, "moveSpace", {
        space_id: cloudflare.space_id,
        parent_space_id: javascript.space_id,
      })
    ).space;
    expect(moved).toMatchObject({
      path: "SDKs › JavaScript › Cloudflare",
      depth: 3,
      conversation_count: 3,
    });
    await expect(
      run(tools, "moveSpace", {
        space_id: sdks.space_id,
        parent_space_id: cloudflare.space_id,
      }),
    ).rejects.toThrow("cannot move under itself");

    // Finding Conversations to move searches public Conversations only.
    const found = await run(tools, "findSpaceConversations", {
      query: "public-other",
    });
    expect(
      found.conversations.map((row: any) => [
        row.conversation_id,
        row.space_path,
      ]),
    ).toEqual([[PUBLIC_OTHER, "SDKs › JavaScript › Cloudflare"]]);
    expect(
      (await run(tools, "findSpaceConversations", { query: "private-other" }))
        .conversations,
    ).toEqual([]);

    // Browsing lists public Conversations and only counts private ones.
    const shown = await run(tools, "getSpace", { space_id: sdks.space_id });
    expect(shown.space.total_conversation_count).toBe(3);
    expect(shown.children.map((child: any) => child.name)).toEqual([
      "JavaScript",
    ]);
    expect(
      shown.conversations.map((row: any) => [
        row.conversation_id,
        row.space_path,
        row.summary,
      ]),
    ).toEqual([
      [
        PUBLIC_OTHER,
        "SDKs › JavaScript › Cloudflare",
        `Summary ${PUBLIC_OTHER}`,
      ],
      [CURRENT, "SDKs › JavaScript › Cloudflare", `Summary ${CURRENT}`],
    ]);
    expect(shown.private_conversation_count).toBe(1);

    // Merging keeps the old id resolvable and moves child Spaces and
    // Conversations to the target.
    const merged = await run(tools, "mergeSpace", {
      space_id: cloudflare.space_id,
      into_space_id: javascript.space_id,
    });
    expect(merged).toMatchObject({
      moved_conversations: 3,
      space: { path: "SDKs › JavaScript", conversation_count: 3 },
    });
    const listed = await run(tools, "listSpaces", {});
    expect(listed.current_space_id).toBe(javascript.space_id);
    expect(listed.spaces.map((space: any) => space.path)).toEqual([
      "SDKs",
      "SDKs › JavaScript",
    ]);
    expect(
      (await run(tools, "getSpace", { space_id: cloudflare.space_id })).space
        .space_id,
    ).toBe(javascript.space_id);

    await expect(
      run(tools, "archiveSpace", { space_id: javascript.space_id }),
    ).rejects.toThrow("Only an empty Space can be archived");
    const empty = (
      await run(tools, "createSpace", {
        name: "Python",
        description: "The Python SDK.",
        parent_space_id: sdks.space_id,
      })
    ).space;
    await run(tools, "archiveSpace", { space_id: empty.space_id });
    expect(
      (await getDb().select().from(juniorSpaces)).map((space) => [
        space.name,
        space.status,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["Cloudflare", "merged"],
        ["Python", "archived"],
      ]),
    );

    const changes = await getDb().select().from(juniorSpaceChanges);
    expect(new Set(changes.map((change) => change.kind))).toEqual(
      new Set(["create", "assign", "move", "merge", "archive"]),
    );
    expect(
      changes.every(
        (change) =>
          change.actorKind === "agent" &&
          change.actorConversationId === CURRENT,
      ),
    ).toBe(true);
  });
});
