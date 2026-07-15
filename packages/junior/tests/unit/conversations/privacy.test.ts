import { describe, expect, it } from "vitest";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";

interface ConversationRow {
  destinationId: string | null;
  parentId: string | null;
  rootId: string | null;
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
  it("resolves visibility only from a consistent root destination", async () => {
    const result = await resolveRootVisibility(
      scriptedExecutor({
        conversations: [
          { destinationId: null, parentId: "root", rootId: "root" },
          { destinationId: "destination", parentId: null, rootId: null },
          { destinationId: "destination", parentId: null, rootId: null },
          { destinationId: null, parentId: "root", rootId: "root" },
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
      rows: [{ destinationId: null, parentId: "missing", rootId: "root" }],
    },
    {
      name: "a historical child without a declared root",
      rows: [{ destinationId: null, parentId: "root", rootId: null }],
    },
    {
      name: "an inconsistent intermediate root",
      rows: [
        { destinationId: null, parentId: "parent", rootId: "root" },
        { destinationId: null, parentId: "root", rootId: "other-root" },
      ],
    },
    {
      name: "a missing root destination",
      rows: [{ destinationId: null, parentId: null, rootId: null }],
    },
  ])("fails closed for $name", async ({ rows }) => {
    await expect(
      resolveRootVisibility(
        scriptedExecutor({ conversations: rows }),
        "requested",
      ),
    ).resolves.toMatchObject({ visibility: null });
  });

  it("fails closed when lineage contains a cycle", async () => {
    const result = await resolveRootVisibility(
      scriptedExecutor({
        conversations: [
          { destinationId: null, parentId: "parent", rootId: "root" },
          { destinationId: null, parentId: "requested", rootId: "root" },
        ],
      }),
      "requested",
    );

    expect(result.visibility).toBeNull();
  });

  it("fails closed when lineage changes between discovery and locking", async () => {
    const result = await resolveRootVisibility(
      scriptedExecutor({
        conversations: [
          { destinationId: null, parentId: "root", rootId: "root" },
          {
            destinationId: "destination",
            parentId: null,
            rootId: null,
          },
          {
            destinationId: "destination",
            parentId: null,
            rootId: null,
          },
          {
            destinationId: null,
            parentId: "different-root",
            rootId: "different-root",
          },
        ],
        visibility: "public",
      }),
      "child",
    );

    expect(result.visibility).toBeNull();
  });

  it("fails closed when lineage exceeds the traversal bound", async () => {
    const conversations = Array.from({ length: 32 }, (_, index) => ({
      destinationId: null,
      parentId: `node-${index + 1}`,
      rootId: "root",
    }));

    const result = await resolveRootVisibility(
      scriptedExecutor({ conversations }),
      "node-0",
    );

    expect(result.visibility).toBeNull();
  });
});
