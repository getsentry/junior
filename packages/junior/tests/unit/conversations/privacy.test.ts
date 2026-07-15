import { describe, expect, it } from "vitest";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";

interface ConversationRow {
  destinationId: string | null;
  parentId: string | null;
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
          { destinationId: null, parentId: "root" },
          { destinationId: "destination", parentId: null },
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
      rows: [{ destinationId: null, parentId: "missing" }],
    },
    {
      name: "a missing root destination",
      rows: [{ destinationId: null, parentId: null }],
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
