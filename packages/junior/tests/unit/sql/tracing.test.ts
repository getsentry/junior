import { describe, expect, it, vi } from "vitest";

const { startSpan } = vi.hoisted(() => ({
  startSpan: vi.fn((options: unknown, callback: () => unknown) => callback()),
}));

vi.mock("@/chat/sentry", () => ({ startSpan }));

import { traceQueries } from "@/db/tracing";

describe("SQL tracing", () => {
  it("adds safe query metadata without changing the query", async () => {
    const result = Promise.resolve({ rows: [{ id: "1" }] });
    const queryClient = vi.fn((_query: unknown) => result);
    const client = { query: queryClient };
    const traced = traceQueries(client, "neon");
    const query = {
      text: "  select * from junior_conversations where id = $1",
      values: ["private-id"],
    };

    await expect(traced.query(query)).resolves.toEqual({ rows: [{ id: "1" }] });

    expect(queryClient).toHaveBeenCalledWith(query);
    expect(startSpan).toHaveBeenCalledWith(
      {
        name: "SELECT",
        op: "db.query",
        onlyIfParent: true,
        attributes: {
          "app.db.driver": "neon",
          "db.operation.name": "SELECT",
          "db.system.name": "postgresql",
        },
      },
      expect.any(Function),
    );
    expect(JSON.stringify(startSpan.mock.calls[0]?.[0])).not.toContain(
      "private-id",
    );
    expect(JSON.stringify(startSpan.mock.calls[0]?.[0])).not.toContain(
      "junior_conversations",
    );
  });
});
