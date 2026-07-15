import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { eq } from "drizzle-orm";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { resolveRootVisibility } from "@/chat/conversations/sql/purge";
import {
  SubagentLineageConflictError,
  SubagentLineageService,
} from "@/chat/services/subagent-lineage";
import { juniorConversations } from "@/db/schema";
import { migrateConversationLineage } from "@/cli/upgrade/migrations/conversation-lineage";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

async function appendTurnStarted(
  eventStore: ReturnType<typeof createSqlConversationEventStore>,
  conversationId: string,
  turnId: string,
) {
  await eventStore.append(conversationId, [
    {
      data: {
        type: "turn_started",
        turnId,
        inputMessageIds: [`${turnId}:input`],
        surface: "internal",
      },
      idempotencyKey: `turn:${turnId}:started`,
      createdAtMs: 1,
    },
  ]);
}

describe("subagent lineage service", () => {
  it("records direct and nested references without copying child events", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      const lineage = new SubagentLineageService(fixture.sql);
      await store.recordActivity({
        conversationId: "root",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        source: "slack",
        visibility: "private",
        nowMs: 1,
      });
      await appendTurnStarted(events, "root", "root-turn");

      const child = await lineage.start({
        childConversationId: "child",
        historyMode: "shared",
        parentConversationId: "root",
        parentTurnId: "root-turn",
        subagentInvocationId: "child-call",
        subagentKind: "task",
        nowMs: 2,
      });
      expect(child).toMatchObject({
        contextForkSeq: child.parentEventSeq,
        rootConversationId: "root",
      });
      await expect(
        store.get({ conversationId: "child" }),
      ).resolves.toMatchObject({
        lineage: {
          contextForkSeq: child.parentEventSeq,
          parentConversationId: "root",
          parentEventSeq: child.parentEventSeq,
          parentTurnId: "root-turn",
          rootConversationId: "root",
        },
      });
      await events.append("child", [
        {
          data: {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "child-only" }],
              timestamp: 3,
            } as PiMessage,
          },
          createdAtMs: 3,
        },
      ]);
      await appendTurnStarted(events, "child", "child-turn");
      const grandchild = await lineage.start({
        childConversationId: "grandchild",
        historyMode: "isolated",
        parentConversationId: "child",
        parentTurnId: "child-turn",
        subagentInvocationId: "grandchild-call",
        subagentKind: "review",
        nowMs: 4,
      });
      expect(grandchild).toMatchObject({
        contextForkSeq: null,
        rootConversationId: "root",
      });
      await lineage.finish({
        parentConversationId: "child",
        parentTurnId: "child-turn",
        subagentInvocationId: "grandchild-call",
        outcome: "success",
        nowMs: 5,
      });

      const rootHistory = await events.loadHistory("root");
      const childHistory = await events.loadHistory("child");
      expect(rootHistory.map((event) => event.data.type)).toEqual([
        "turn_started",
        "subagent_started",
      ]);
      expect(JSON.stringify(rootHistory)).not.toContain("child-only");
      expect(childHistory.map((event) => event.data.type)).toEqual([
        "message",
        "turn_started",
        "subagent_started",
        "subagent_ended",
      ]);
      await expect(
        resolveRootVisibility(fixture.sql, "grandchild"),
      ).resolves.toEqual({ rootConversationId: "root", visibility: "private" });
    } finally {
      await fixture.close();
    }
  });

  it("replays exact references and rejects mode, correlation, and reparenting conflicts", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      const lineage = new SubagentLineageService(fixture.sql);
      await appendTurnStarted(events, "parent-a", "turn-a");
      await appendTurnStarted(events, "parent-b", "turn-b");
      await expect(
        lineage.start({
          childConversationId: "orphaned-turn-child",
          historyMode: "isolated",
          parentConversationId: "parent-a",
          parentTurnId: "missing-turn",
          subagentInvocationId: "missing-turn-call",
          subagentKind: "task",
        }),
      ).rejects.toBeInstanceOf(SubagentLineageConflictError);
      const input = {
        childConversationId: "child",
        historyMode: "shared" as const,
        parentConversationId: "parent-a",
        parentTurnId: "turn-a",
        subagentInvocationId: "call",
        subagentKind: "task",
        nowMs: 2,
      };
      const first = await lineage.start(input);
      await expect(lineage.start(input)).resolves.toEqual(first);
      await lineage.finish({
        parentConversationId: "parent-a",
        parentTurnId: "turn-a",
        subagentInvocationId: "call",
        outcome: "success",
        nowMs: 3,
      });
      await expect(
        lineage.finish({
          parentConversationId: "parent-a",
          parentTurnId: "turn-a",
          subagentInvocationId: "call",
          outcome: "success",
          nowMs: 4,
        }),
      ).resolves.toBeUndefined();
      await expect(
        lineage.start({ ...input, historyMode: "isolated" }),
      ).rejects.toBeInstanceOf(SubagentLineageConflictError);
      await expect(
        lineage.start({
          ...input,
          parentConversationId: "parent-b",
          parentTurnId: "turn-b",
          subagentInvocationId: "other-call",
        }),
      ).rejects.toBeInstanceOf(SubagentLineageConflictError);
      expect(
        (await events.loadHistory("parent-b")).map((event) => event.data.type),
      ).toEqual(["turn_started"]);
      expect(
        (await events.loadHistory("parent-a")).filter(
          (event) => event.data.type === "subagent_started",
        ),
      ).toHaveLength(1);
      expect(
        (await events.loadHistory("parent-a")).filter(
          (event) => event.data.type === "subagent_ended",
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("upgrades only metadata-bare children and rolls back a real-root conflict", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      const lineage = new SubagentLineageService(fixture.sql);
      await appendTurnStarted(events, "parent", "turn");
      await events.append("bare-child", [
        {
          data: {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "created before lineage" }],
              timestamp: 1,
            } as PiMessage,
          },
          createdAtMs: 1,
        },
      ]);
      await expect(
        lineage.start({
          childConversationId: "bare-child",
          historyMode: "isolated",
          parentConversationId: "parent",
          parentTurnId: "turn",
          subagentInvocationId: "bare-call",
          subagentKind: "task",
          nowMs: 2,
        }),
      ).resolves.toMatchObject({ rootConversationId: "parent" });

      await store.recordActivity({
        conversationId: "real-root",
        source: "local",
        nowMs: 2,
      });
      await expect(
        lineage.start({
          childConversationId: "real-root",
          historyMode: "isolated",
          parentConversationId: "parent",
          parentTurnId: "turn",
          subagentInvocationId: "conflict-call",
          subagentKind: "task",
          nowMs: 3,
        }),
      ).rejects.toBeInstanceOf(SubagentLineageConflictError);
      for (const [childConversationId, fields, invocationId] of [
        ["purged-root", { transcriptPurgedAt: new Date(3) }, "purged-call"],
        [
          "execution-root",
          {
            executionStatus: "running" as const,
            executionUpdatedAt: new Date(3),
            lastCheckpointAt: new Date(3),
          },
          "execution-call",
        ],
      ] as const) {
        await events.append(childConversationId, [
          {
            data: {
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "existing root content" }],
                timestamp: 2,
              } as PiMessage,
            },
            createdAtMs: 2,
          },
        ]);
        await fixture.sql
          .db()
          .update(juniorConversations)
          .set(fields)
          .where(eq(juniorConversations.conversationId, childConversationId));
        await expect(
          lineage.start({
            childConversationId,
            historyMode: "isolated",
            parentConversationId: "parent",
            parentTurnId: "turn",
            subagentInvocationId: invocationId,
            subagentKind: "task",
            nowMs: 3,
          }),
        ).rejects.toBeInstanceOf(SubagentLineageConflictError);
      }
      expect(
        (await events.loadHistory("parent")).filter(
          (event) =>
            event.data.type === "subagent_started" &&
            event.data.subagentInvocationId === "conflict-call",
        ),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("atomically resolves different parents racing for one child", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      const lineage = new SubagentLineageService(fixture.sql);
      await appendTurnStarted(events, "parent-a", "turn-a");
      await appendTurnStarted(events, "parent-b", "turn-b");
      const results = await Promise.allSettled([
        lineage.start({
          childConversationId: "contended-child",
          historyMode: "isolated",
          parentConversationId: "parent-a",
          parentTurnId: "turn-a",
          subagentInvocationId: "call-a",
          subagentKind: "task",
        }),
        lineage.start({
          childConversationId: "contended-child",
          historyMode: "isolated",
          parentConversationId: "parent-b",
          parentTurnId: "turn-b",
          subagentInvocationId: "call-b",
          subagentKind: "task",
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const childRows = await fixture.sql
        .db()
        .select()
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, "contended-child"));
      const winner = childRows[0]?.parentConversationId;
      expect(winner === "parent-a" || winner === "parent-b").toBe(true);
      for (const parent of ["parent-a", "parent-b"]) {
        const starts = (await events.loadHistory(parent)).filter(
          (event) => event.data.type === "subagent_started",
        );
        expect(starts).toHaveLength(parent === winner ? 1 : 0);
      }
    } finally {
      await fixture.close();
    }
  });

  it("backfills historical roots in bounded rerunnable batches without inventing forks", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const at = new Date(1);
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values([
          {
            conversationId: "root",
            createdAt: at,
            lastActivityAt: at,
            updatedAt: at,
            executionStatus: "idle",
          },
          {
            conversationId: "child",
            parentConversationId: "root",
            createdAt: at,
            lastActivityAt: at,
            updatedAt: at,
            executionStatus: "idle",
          },
          {
            conversationId: "grandchild",
            parentConversationId: "child",
            createdAt: at,
            lastActivityAt: at,
            updatedAt: at,
            executionStatus: "idle",
          },
        ]);
      await expect(
        migrateConversationLineage({} as never, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toMatchObject({ migrated: 2 });
      const rows = await fixture.sql
        .db()
        .select()
        .from(juniorConversations)
        .where(eq(juniorConversations.rootConversationId, "root"));
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: "child",
            contextForkSeq: null,
            parentEventSeq: null,
            parentTurnId: null,
          }),
          expect.objectContaining({
            conversationId: "grandchild",
            contextForkSeq: null,
            parentEventSeq: null,
            parentTurnId: null,
          }),
        ]),
      );
      await expect(
        migrateConversationLineage({} as never, { executor: fixture.sql }),
      ).resolves.toMatchObject({ migrated: 0 });
    } finally {
      await fixture.close();
    }
  });

  it("rejects partial lineage while allowing historical uncorrelated children", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const at = new Date(1);
      const base = {
        createdAt: at,
        lastActivityAt: at,
        updatedAt: at,
        executionStatus: "idle" as const,
      };
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({ conversationId: "root", ...base });
      await expect(
        fixture.sql
          .db()
          .insert(juniorConversations)
          .values({
            conversationId: "poisoned-root",
            rootConversationId: "root",
            ...base,
          }),
      ).rejects.toThrow("Failed query");
      await expect(
        fixture.sql
          .db()
          .insert(juniorConversations)
          .values({
            conversationId: "half-correlated-child",
            parentConversationId: "root",
            rootConversationId: "root",
            parentTurnId: "turn",
            ...base,
          }),
      ).rejects.toThrow("Failed query");
      await expect(
        fixture.sql
          .db()
          .insert(juniorConversations)
          .values({
            conversationId: "rootless-correlated-child",
            parentConversationId: "root",
            parentTurnId: "turn",
            parentEventSeq: 1,
            ...base,
          }),
      ).rejects.toThrow("Failed query");
      await expect(
        fixture.sql
          .db()
          .insert(juniorConversations)
          .values({
            conversationId: "historical-child",
            parentConversationId: "root",
            ...base,
          }),
      ).resolves.toBeDefined();
    } finally {
      await fixture.close();
    }
  });
});
