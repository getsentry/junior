import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  commitMessages,
  ConversationLineageProjectionError,
  MAX_LINEAGE_PROJECTION_DEPTH,
  loadConversationProjection,
  loadProjection,
  loadTurnProjection,
  openConversationProjection,
} from "@/chat/conversations/projection";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
  getSqlExecutor,
  getSubagentLineageService,
} from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { juniorConversations } from "@/db/schema";
import { resolveRootVisibility } from "@/chat/conversations/sql/purge";
import { purgeConversation } from "@/chat/conversations/retention";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const MODEL_ID = "openai/gpt-5.4";

function message(role: "assistant" | "user", text: string): PiMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
  } as PiMessage;
}

async function appendTurn(conversationId: string, turnId: string) {
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "turn_started",
        turnId,
        inputMessageIds: [`${turnId}:input`],
        surface: "internal",
      },
      idempotencyKey: `turn:${turnId}:started`,
      createdAtMs: 2,
    },
  ]);
}

async function startChild(args: {
  childConversationId: string;
  historyMode: "isolated" | "shared";
  parentConversationId: string;
  parentTurnId: string;
}) {
  return await getSubagentLineageService().start({
    ...args,
    subagentInvocationId: `${args.childConversationId}:invocation`,
    subagentKind: "task",
    nowMs: 3,
  });
}

describe("shared child Pi projection", () => {
  it("pins direct shared context and commits only the child-local suffix", async () => {
    const parent = message("user", "parent before fork");
    await commitMessages({
      conversationId: "shared-parent",
      modelId: MODEL_ID,
      messages: [parent],
    });
    await appendTurn("shared-parent", "parent-turn");
    await startChild({
      childConversationId: "shared-child",
      historyMode: "shared",
      parentConversationId: "shared-parent",
      parentTurnId: "parent-turn",
    });

    await expect(
      openConversationProjection({
        conversationId: "shared-child",
        modelId: MODEL_ID,
      }),
    ).resolves.toMatchObject({ messages: [parent] });
    await expect(
      loadProjection({ conversationId: "shared-child" }),
    ).resolves.toEqual([parent]);

    const child = message("assistant", "child result");
    const commit = await commitMessages({
      conversationId: "shared-child",
      modelId: MODEL_ID,
      messages: [parent, child],
    });
    expect(commit).toMatchObject({
      localMessageStartIndex: 1,
      provenance: expect.any(Array),
    });
    expect(commit.messageSeqs).toHaveLength(1);
    await expect(
      loadConversationProjection({ conversationId: "shared-child" }),
    ).resolves.toMatchObject({ messages: [parent, child] });
    await expect(
      loadTurnProjection({
        conversationId: "shared-child",
        committedSeq: commit.committedSeq,
        includeTail: false,
      }),
    ).resolves.toMatchObject({
      localMessageStartIndex: 1,
      messages: [parent, child],
      seqs: commit.messageSeqs,
    });
    await upsertAgentTurnSessionRecord({
      conversationId: "shared-child",
      modelId: MODEL_ID,
      piMessages: [parent, child],
      sessionId: "shared-child-session",
      sliceId: 1,
      state: "running",
      turnStartMessageIndex: 1,
    });
    await expect(
      getAgentTurnSessionRecord("shared-child", "shared-child-session"),
    ).resolves.toMatchObject({
      piMessages: [parent, child],
      turnStartMessageIndex: 1,
    });

    const childHistory =
      await getConversationEventStore().loadHistory("shared-child");
    expect(
      childHistory.flatMap((event) =>
        event.data.type === "message" ? [event.data.message] : [],
      ),
    ).toEqual([child]);
    expect(childHistory).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "context_epoch_started",
          reason: "initial",
          inheritsLineageContext: true,
        }),
      }),
    );

    const regeneratedChild = message("assistant", "regenerated child result");
    await commitMessages({
      conversationId: "shared-child",
      modelId: MODEL_ID,
      messages: [parent, regeneratedChild],
    });
    const rollbackEpoch =
      await getConversationEventStore().loadCurrentEpoch("shared-child");
    expect(rollbackEpoch).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "context_epoch_started",
          reason: "rollback",
          inheritsLineageContext: true,
        }),
      }),
    );
    expect(
      rollbackEpoch.flatMap((event) =>
        event.data.type === "message" ? [event.data.message] : [],
      ),
    ).toEqual([regeneratedChild]);

    const parentAfterFork = message("assistant", "parent after fork");
    await commitMessages({
      conversationId: "shared-parent",
      modelId: MODEL_ID,
      messages: [parent, parentAfterFork],
    });
    await getConversationEventStore().startEpoch("shared-parent", {
      reason: "compaction",
      modelProfile: "standard",
      modelId: MODEL_ID,
      messages: [
        {
          message: message("user", "later parent compaction"),
          createdAtMs: 4,
        },
      ],
    });
    await expect(
      loadProjection({ conversationId: "shared-child" }),
    ).resolves.toEqual([parent, regeneratedChild]);

    const historyLength = (
      await getConversationEventStore().loadHistory("shared-child")
    ).length;
    await expect(
      commitMessages({
        conversationId: "shared-child",
        modelId: MODEL_ID,
        messages: [message("user", "mutated parent"), regeneratedChild],
      }),
    ).rejects.toBeInstanceOf(ConversationLineageProjectionError);
    expect(
      await getConversationEventStore().loadHistory("shared-child"),
    ).toHaveLength(historyLength);

    await getConversationEventStore().startEpoch("shared-child", {
      reason: "compaction",
      modelProfile: "standard",
      modelId: MODEL_ID,
      messages: [
        {
          message: message("user", "self-contained child summary"),
          createdAtMs: 5,
        },
      ],
    });
    await expect(
      loadProjection({ conversationId: "shared-child" }),
    ).resolves.toEqual([message("user", "self-contained child summary")]);
  });

  it("recursively composes nested shared children at each immutable fork", async () => {
    const root = message("user", "root context");
    await commitMessages({
      conversationId: "nested-root",
      modelId: MODEL_ID,
      messages: [root],
    });
    await appendTurn("nested-root", "root-turn");
    await startChild({
      childConversationId: "nested-child",
      historyMode: "shared",
      parentConversationId: "nested-root",
      parentTurnId: "root-turn",
    });
    const child = message("assistant", "child context");
    await commitMessages({
      conversationId: "nested-child",
      modelId: MODEL_ID,
      messages: [root, child],
    });
    await appendTurn("nested-child", "child-turn");
    await startChild({
      childConversationId: "nested-grandchild",
      historyMode: "shared",
      parentConversationId: "nested-child",
      parentTurnId: "child-turn",
    });

    await expect(
      loadProjection({ conversationId: "nested-grandchild" }),
    ).resolves.toEqual([root, child]);
    const lateChild = message("user", "child after grandchild fork");
    await commitMessages({
      conversationId: "nested-child",
      modelId: MODEL_ID,
      messages: [root, child, lateChild],
    });
    await expect(
      loadProjection({ conversationId: "nested-grandchild" }),
    ).resolves.toEqual([root, child]);

    const grandchild = message("assistant", "grandchild result");
    await commitMessages({
      conversationId: "nested-grandchild",
      modelId: MODEL_ID,
      messages: [root, child, grandchild],
    });
    const grandchildMessages = (
      await getConversationEventStore().loadHistory("nested-grandchild")
    ).flatMap((event) =>
      event.data.type === "message" ? [event.data.message] : [],
    );
    expect(grandchildMessages).toEqual([grandchild]);
  });

  it("keeps isolated and historical null-fork children child-local", async () => {
    const parent = message("user", "private parent context");
    await commitMessages({
      conversationId: "isolated-parent",
      modelId: MODEL_ID,
      messages: [parent],
    });
    await appendTurn("isolated-parent", "isolated-parent-turn");
    await startChild({
      childConversationId: "isolated-child",
      historyMode: "isolated",
      parentConversationId: "isolated-parent",
      parentTurnId: "isolated-parent-turn",
    });
    await expect(
      loadProjection({ conversationId: "isolated-child" }),
    ).resolves.toEqual([]);

    const local = message("user", "isolated instruction");
    await commitMessages({
      conversationId: "isolated-child",
      modelId: MODEL_ID,
      messages: [local],
    });
    await expect(
      loadProjection({ conversationId: "isolated-child" }),
    ).resolves.toEqual([local]);
    expect(
      await getConversationEventStore().loadHistory("isolated-child"),
    ).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ inheritsLineageContext: true }),
      }),
    );

    const sibling = await startChild({
      childConversationId: "isolated-sibling",
      historyMode: "isolated",
      parentConversationId: "isolated-parent",
      parentTurnId: "isolated-parent-turn",
    });
    await getDb()
      .update(juniorConversations)
      .set({ parentEventSeq: sibling.parentEventSeq })
      .where(eq(juniorConversations.conversationId, "isolated-child"));
    await expect(
      loadProjection({ conversationId: "isolated-child" }),
    ).rejects.toBeInstanceOf(ConversationLineageProjectionError);
    await getDb()
      .update(juniorConversations)
      .set({ parentEventSeq: null, parentTurnId: null })
      .where(eq(juniorConversations.conversationId, "isolated-sibling"));
    await expect(
      loadProjection({ conversationId: "isolated-sibling" }),
    ).resolves.toEqual([]);
  });

  it("fails closed when shared correlation no longer identifies its fork", async () => {
    await commitMessages({
      conversationId: "conflict-parent",
      modelId: MODEL_ID,
      messages: [message("user", "parent")],
    });
    await appendTurn("conflict-parent", "conflict-turn");
    const lineage = await startChild({
      childConversationId: "conflict-child",
      historyMode: "shared",
      parentConversationId: "conflict-parent",
      parentTurnId: "conflict-turn",
    });
    await getDb()
      .update(juniorConversations)
      .set({ contextForkSeq: lineage.parentEventSeq - 1 })
      .where(eq(juniorConversations.conversationId, "conflict-child"));

    await expect(
      loadProjection({ conversationId: "conflict-child" }),
    ).rejects.toBeInstanceOf(ConversationLineageProjectionError);
  });

  it("rejects a shared reference whose durable fork was cleared", async () => {
    await appendTurn("lost-fork-parent", "lost-fork-turn");
    await startChild({
      childConversationId: "lost-fork-child",
      historyMode: "shared",
      parentConversationId: "lost-fork-parent",
      parentTurnId: "lost-fork-turn",
    });
    await getDb()
      .update(juniorConversations)
      .set({ contextForkSeq: null })
      .where(eq(juniorConversations.conversationId, "lost-fork-child"));
    await expect(
      loadProjection({ conversationId: "lost-fork-child" }),
    ).rejects.toBeInstanceOf(ConversationLineageProjectionError);
  });

  it("fails closed beyond the bounded shared-lineage projection depth", async () => {
    let parentConversationId = "depth-root";
    let parentTurnId = "depth-turn-0";
    await appendTurn(parentConversationId, parentTurnId);
    for (let depth = 1; depth <= MAX_LINEAGE_PROJECTION_DEPTH + 1; depth += 1) {
      const childConversationId = `depth-child-${depth}`;
      await startChild({
        childConversationId,
        historyMode: "shared",
        parentConversationId,
        parentTurnId,
      });
      parentConversationId = childConversationId;
      parentTurnId = `depth-turn-${depth}`;
      await appendTurn(parentConversationId, parentTurnId);
    }
    await expect(
      loadProjection({ conversationId: parentConversationId }),
    ).rejects.toThrow("exceeds maximum projection depth");
  });

  it("fails closed when correlated shared lineage forms a cycle", async () => {
    await appendTurn("cycle-root", "cycle-root-turn");
    await appendTurn("cycle-a", "cycle-a-turn");
    await startChild({
      childConversationId: "cycle-b",
      historyMode: "shared",
      parentConversationId: "cycle-a",
      parentTurnId: "cycle-a-turn",
    });
    await appendTurn("cycle-b", "cycle-b-turn");
    await getConversationEventStore().append("cycle-b", [
      {
        data: {
          type: "subagent_started",
          subagentInvocationId: "cycle-a:invocation",
          subagentKind: "task",
          childConversationId: "cycle-a",
          parentTurnId: "cycle-b-turn",
          historyMode: "shared",
        },
        createdAtMs: 4,
      },
    ]);
    const cycleAReference = (
      await getConversationEventStore().loadHistory("cycle-b")
    ).find(
      (event) =>
        event.data.type === "subagent_started" &&
        event.data.childConversationId === "cycle-a",
    )!;
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: "cycle-root" })
      .where(eq(juniorConversations.conversationId, "cycle-b"));
    await getDb()
      .update(juniorConversations)
      .set({
        parentConversationId: "cycle-b",
        rootConversationId: "cycle-root",
        parentTurnId: "cycle-b-turn",
        parentEventSeq: cycleAReference.seq,
        contextForkSeq: cycleAReference.seq,
      })
      .where(eq(juniorConversations.conversationId, "cycle-a"));
    await expect(loadProjection({ conversationId: "cycle-b" })).rejects.toThrow(
      "contains a cycle",
    );
  });

  it("serializes concurrent commits into individually reproducible boundaries", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const base = message("user", "base");
      await commitMessages({
        conversationId: "concurrent-commit",
        executor: fixture.sql,
        modelId: MODEL_ID,
        messages: [base],
      });
      const left = [base, message("assistant", "left")];
      const right = [base, message("assistant", "right")];
      const [leftCommit, rightCommit] = await Promise.all([
        commitMessages({
          conversationId: "concurrent-commit",
          executor: fixture.sql,
          modelId: MODEL_ID,
          messages: left,
        }),
        commitMessages({
          conversationId: "concurrent-commit",
          executor: fixture.sql,
          modelId: MODEL_ID,
          messages: right,
        }),
      ]);
      const history = await createSqlConversationEventStore(
        fixture.sql,
      ).loadHistory("concurrent-commit");
      const projectionAt = (committedSeq: number) => {
        const committed = history.find((event) => event.seq === committedSeq)!;
        return projectConversationEvents(
          history.filter(
            (event) =>
              event.contextEpoch === committed.contextEpoch &&
              event.seq <= committedSeq,
          ),
        );
      };
      expect(projectionAt(leftCommit.committedSeq)).toMatchObject({
        messages: left,
        provenance: leftCommit.provenance,
      });
      expect(projectionAt(rightCommit.committedSeq)).toMatchObject({
        messages: right,
        provenance: rightCommit.provenance,
      });
    } finally {
      await fixture.close();
    }
  });

  it("inherits a pre-fork compaction or handoff as a self-contained parent epoch", async () => {
    for (const [reason, profile] of [
      ["compaction", "standard"],
      ["handoff", "handoff"],
    ] as const) {
      const parentConversationId = `pre-fork-${reason}-parent`;
      const childConversationId = `pre-fork-${reason}-child`;
      await commitMessages({
        conversationId: parentConversationId,
        modelId: MODEL_ID,
        messages: [message("user", "discarded parent context")],
      });
      const replacement = message("user", `${reason} replacement`);
      await getConversationEventStore().startEpoch(parentConversationId, {
        reason,
        modelProfile: profile,
        modelId: MODEL_ID,
        messages: [{ message: replacement, createdAtMs: 2 }],
      });
      const turnId = `pre-fork-${reason}-turn`;
      await appendTurn(parentConversationId, turnId);
      await startChild({
        childConversationId,
        historyMode: "shared",
        parentConversationId,
        parentTurnId: turnId,
      });
      await expect(
        loadProjection({ conversationId: childConversationId }),
      ).resolves.toEqual([replacement]);
    }
  });

  it("rejects inherited provenance mutation and follows private-root purge", async () => {
    await getConversationStore().recordActivity({
      conversationId: "private-root",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      source: "slack",
      visibility: "private",
      nowMs: 1,
    });
    const parent = message("user", "private inherited context");
    await commitMessages({
      conversationId: "private-root",
      modelId: MODEL_ID,
      messages: [parent],
    });
    await appendTurn("private-root", "private-turn");
    await startChild({
      childConversationId: "private-child",
      historyMode: "shared",
      parentConversationId: "private-root",
      parentTurnId: "private-turn",
    });
    await expect(
      commitMessages({
        conversationId: "private-child",
        modelId: MODEL_ID,
        messages: [parent],
        provenance: [{ authority: "instruction" }],
      }),
    ).rejects.toThrow("mutated inherited provenance");
    await expect(
      resolveRootVisibility(getSqlExecutor(), "private-child"),
    ).resolves.toEqual({
      rootConversationId: "private-root",
      visibility: "private",
    });
    await purgeConversation(getSqlExecutor(), "private-root", { nowMs: 10 });
    await expect(
      loadProjection({ conversationId: "private-child" }),
    ).rejects.toThrow("conversation lineage reference conflicts");
  });
});
