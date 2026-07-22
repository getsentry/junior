import { describe, expect, it } from "vitest";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";

interface ConversationRow {
  requestedRootConversationId: string | null;
  rootConversationId: string | null;
  rootDestinationId: string | null;
  rootParentConversationId: string | null;
  rootRootConversationId: string | null;
}

function scriptedExecutor(args: {
  conversations: Array<ConversationRow | undefined>;
  visibility?: "private" | "public";
}): JuniorSqlDatabase {
  const conversations = [...args.conversations];
  const db = {
    select: () => {
      let source: unknown;
      const readRows = () => {
        if (source === juniorConversations) {
          const row = conversations.shift();
          return row ? [row] : [];
        }
        if (source === juniorDestinations) {
          return args.visibility ? [{ visibility: args.visibility }] : [];
        }
        throw new Error("Unexpected privacy resolver table");
      };
      const query = {
        from(table: unknown) {
          source = table;
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          const rows = Promise.resolve(readRows());
          return Object.assign(rows, {
            for: async () => rows,
          });
        },
      };
      return query;
    },
  };
  return {
    db: () => db,
    transaction: async <T>(callback: () => Promise<T>): Promise<T> =>
      callback(),
    withLock: async <T>(
      _name: string,
      callback: () => Promise<T>,
    ): Promise<T> => callback(),
  } as unknown as JuniorSqlDatabase;
}

describe("resolveRootVisibility", () => {
  it("resolves visibility from the persisted root destination", async () => {
    const result = await resolveRootVisibility(
      scriptedExecutor({
        conversations: [
          {
            requestedRootConversationId: "root",
            rootConversationId: "root",
            rootDestinationId: "destination",
            rootParentConversationId: null,
            rootRootConversationId: "root",
          },
        ],
        visibility: "public",
      }),
      "child",
    );

    expect(result).toEqual({
      rootConversationId: "root",
      visibility: "public",
    });
  });

  it.each([
    {
      name: "a missing requested conversation",
      rows: [],
    },
    {
      name: "a missing parent",
      rows: [
        {
          requestedRootConversationId: "missing",
          rootConversationId: null,
          rootDestinationId: null,
          rootParentConversationId: null,
          rootRootConversationId: null,
        },
      ],
    },
    {
      name: "a missing root destination",
      rows: [
        {
          requestedRootConversationId: "requested",
          rootConversationId: "requested",
          rootDestinationId: null,
          rootParentConversationId: null,
          rootRootConversationId: "requested",
        },
      ],
    },
  ])("fails closed for $name", async ({ rows }) => {
    await expect(
      resolveRootVisibility(
        scriptedExecutor({ conversations: rows }),
        "requested",
      ),
    ).resolves.toMatchObject({ visibility: null });
  });
});
