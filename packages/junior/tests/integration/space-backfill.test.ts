import { afterEach, describe, expect, it } from "vitest";
import { appendConversationBrief } from "@/chat/briefs/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import {
  readSpaceBackfillCandidates,
  renderSpaceBackfillMarkdown,
  runSpaceBackfill,
} from "@/chat/spaces/backfill";
import type { SpaceClassificationOutput } from "@/chat/spaces/classify";
import {
  juniorConversationSpaces,
  juniorSpaceChanges,
  juniorSpaces,
} from "@/db/schema";
import { conversationBriefFixture } from "../fixtures/conversation-brief";

async function recordConversation(
  conversationId: string,
  title: string,
  visibility: "public" | "private",
  nowMs: number,
) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs,
    source: "local",
    title,
    visibility,
  });
  await appendConversationBrief(getDb(), {
    conversationId,
    turnId: "turn-1",
    throughSeq: 1,
    content: conversationBriefFixture({ summary: title }),
    searchText: title,
    modelId: "test-model",
  });
}

/** Fake classifier: SDK work goes under SDKs, everything else to Replay. */
function classifier(prompts: string[]) {
  return async (request: { prompt: string }) => {
    prompts.push(request.prompt);
    const has = (name: string) =>
      new RegExp(`- (S\\d+) ${name} `).exec(request.prompt)?.[1] ?? null;
    const isSdk = request.prompt.includes("Summary: SDK");
    const object: SpaceClassificationOutput = isSdk
      ? has("SDKs")
        ? {
            decision: "existing",
            spaceHandle: has("SDKs"),
            parentHandle: null,
            name: null,
            description: null,
            kind: "feature",
            confidence: 0.9,
            reason: "SDK work.",
          }
        : {
            decision: "create",
            spaceHandle: null,
            parentHandle: null,
            name: "SDKs",
            description: "Client SDK work.",
            kind: "feature",
            confidence: 0.9,
            reason: "SDK work.",
          }
      : {
          decision: "create",
          spaceHandle: null,
          parentHandle: has("SDKs"),
          name: "Replay",
          description: "Session Replay SDK work.",
          kind: "bug",
          confidence: 0.5,
          reason: "Replay work.",
        };
    return { costUsd: 0.01, object };
  };
}

describe("Space backfill", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("previews the emerging tree, then applies it in historic order", async () => {
    await recordConversation("local:backfill:one", "SDK release", "public", 1);
    await recordConversation("local:backfill:two", "Replay", "private", 2);
    await recordConversation("local:backfill:three", "SDK docs", "public", 3);
    await recordConversation("local:backfill:four", "Replay bug", "public", 4);

    const candidates = await readSpaceBackfillCandidates(getDb());
    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "local:backfill:one",
      "local:backfill:two",
      "local:backfill:three",
      "local:backfill:four",
    ]);

    const dryPrompts: string[] = [];
    const preview = await runSpaceBackfill(getDb(), {
      candidates,
      apply: false,
      completeObject: classifier(dryPrompts),
    });
    expect(await getDb().select().from(juniorSpaces)).toEqual([]);
    // The private Conversation could not create Replay, so it joined SDKs.
    expect(dryPrompts[1]).toContain("Do not create one.");
    expect(renderSpaceBackfillMarkdown(preview, { apply: false })).toBe(
      [
        "# Space backfill (dry run)",
        "",
        "- Conversations assigned: 4",
        "- Conversations left unassigned: 0",
        "- Spaces created: 2",
        "- Spaces in tree: 2",
        "- Kinds: 2 feature, 2 bug",
        "- Model cost: $0.0400",
        "",
        "- **SDKs** (4) — Client SDK work",
        "  - _SDK release_",
        "  - _SDK docs_",
        "  - **Replay** (1) — Session Replay SDK work",
        "    - _Replay bug_",
        "",
      ].join("\n"),
    );

    const applied = await runSpaceBackfill(getDb(), {
      candidates,
      apply: true,
      completeObject: classifier([]),
    });
    expect(applied.tree.size).toBe(2);
    expect(await getDb().select().from(juniorConversationSpaces)).toHaveLength(
      4,
    );
    const changes = await getDb().select().from(juniorSpaceChanges);
    expect(changes.every((change) => change.actorKind === "backfill")).toBe(
      true,
    );
    expect(await readSpaceBackfillCandidates(getDb())).toEqual([]);
  });
});
