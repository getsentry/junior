import { sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeonJuniorSqlExecutor } from "@/db/neon";
import { juniorConversations } from "@/db/schema";
import { mswServer } from "../../msw/server";

const CONNECTION_STRING =
  "postgresql://junior:secret@ep-overflow-test.test.aws.neon.tech/neondb";

const wire = vi.hoisted(() => ({
  clientsOpened: 0,
  websocketQueries: [] as string[],
  httpQueries: [] as string[],
}));

// Fake the WebSocket wire: the bundled pg `Client` that the pool opens.
vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const neon =
    await importOriginal<typeof import("@neondatabase/serverless")>();
  const { EventEmitter } = await import("node:events");
  class FakeClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error?: Error) => void) {
      wire.clientsOpened++;
      setImmediate(() => callback());
    }
    async query(input: string | { text: string; rowMode?: string }) {
      const config = typeof input === "string" ? { text: input } : input;
      wire.websocketQueries.push(config.text);
      await new Promise((resolve) => setImmediate(resolve));
      return {
        command: "SELECT",
        rowCount: 1,
        fields: [{ name: "transport", dataTypeID: 25 }],
        rows:
          config.rowMode === "array"
            ? [["websocket"]]
            : [{ transport: "websocket" }],
      };
    }
    end(callback?: () => void) {
      this._ending = true;
      callback?.();
    }
    ref() {}
    unref() {}
  }
  class Pool extends neon.Pool {
    constructor(...args: ConstructorParameters<typeof neon.Pool>) {
      super(...args);
      Object.defineProperty(this, "Client", { value: FakeClient });
    }
  }
  return { ...neon, Pool };
});

describe("Neon pool overflow", () => {
  let executor: ReturnType<typeof createNeonJuniorSqlExecutor>;

  beforeEach(() => {
    wire.clientsOpened = 0;
    wire.websocketQueries.length = 0;
    wire.httpQueries.length = 0;
    // The driver sends HTTP queries to the regional API host.
    mswServer.use(
      http.post("https://api.test.aws.neon.tech/sql", async ({ request }) => {
        const body = (await request.json()) as { query: string };
        wire.httpQueries.push(body.query);
        // The driver always asks for array rows and builds objects itself.
        return HttpResponse.json({
          command: "SELECT",
          rowCount: 1,
          fields: [{ name: "transport", dataTypeID: 25 }],
          rows: [["http"]],
          rowAsArray: true,
        });
      }),
    );
    executor = createNeonJuniorSqlExecutor({
      connectionString: CONNECTION_STRING,
      statementTimeoutMs: 30_000,
    });
  });

  afterEach(async () => {
    await executor.close();
  });

  it("sends a burst wider than the idle clients over HTTP", async () => {
    // The first query opens the pool's only client, as before.
    await executor.query("select 'warm'");
    expect(wire.clientsOpened).toBe(1);

    const results = await Promise.all([
      executor.query<{ transport: string }>("select $1::text", ["a"]),
      executor.query<{ transport: string }>("select $1::text", ["b"]),
      executor
        .db()
        .select({ transport: juniorConversations.conversationId })
        .from(juniorConversations),
    ]);

    expect(results.map((rows) => rows[0]?.transport)).toEqual([
      "websocket",
      "http",
      "http",
    ]);
    // The overflow opened no WebSocket. Both row modes map over HTTP.
    expect(wire.clientsOpened).toBe(1);
    expect(wire.httpQueries).toEqual([
      "select $1::text",
      'select "conversation_id" from "junior_conversations"',
    ]);

    // Once the client is idle again, the next query reuses it.
    await expect(executor.query("select 'warm again'")).resolves.toEqual([
      { transport: "websocket" },
    ]);
  });

  it("uses a free client while pg-pool hands another one over", async () => {
    // Open two idle clients. Queries under the migration lock never overflow.
    await executor.withMigrationLock("junior_migrations", async () => {
      await Promise.all([
        executor.execute("select 'warm 1'"),
        executor.execute("select 'warm 2'"),
      ]);
    });
    wire.websocketQueries.length = 0;

    const first = executor.query("select 'first'");
    // pg-pool hands the first query its client on the next tick. This tick
    // runs after that and before the first query resumes.
    const second = new Promise((resolve) => {
      process.nextTick(() => resolve(executor.query("select 'second'")));
    });
    await Promise.all([first, second]);

    expect(wire.websocketQueries).toEqual([
      "select 'first'",
      "select 'second'",
    ]);
    expect(wire.httpQueries).toEqual([]);
  });

  it("keeps every query in a transaction on its client", async () => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const transaction = executor.transaction(async () => {
      await finished;
      return await Promise.all([
        executor.query<{ transport: string }>("select 1"),
        executor.query<{ transport: string }>("select 2"),
        executor.query<{ transport: string }>("select 3"),
      ]);
    });
    await vi.waitFor(() => expect(wire.websocketQueries).toContain("BEGIN"));

    // The transaction holds the only client, so a query outside it overflows.
    await executor.db().execute(sql`select 'outside'`);
    finish();

    expect((await transaction).flat()).toEqual([
      { transport: "websocket" },
      { transport: "websocket" },
      { transport: "websocket" },
    ]);
    expect(wire.websocketQueries).toEqual([
      "BEGIN",
      "select 1",
      "select 2",
      "select 3",
      "COMMIT",
    ]);
    expect(wire.httpQueries).toEqual(["select 'outside'"]);
  });

  it("keeps migration queries on WebSocket while the lock holds a client", async () => {
    await executor.withMigrationLock("junior_migrations", async () => {
      // The lock holds the only client, so a plain query would overflow.
      await executor.execute("CREATE INDEX CONCURRENTLY example ON t (c)");
    });

    expect(wire.clientsOpened).toBe(2);
    expect(wire.websocketQueries).toEqual([
      "SELECT pg_advisory_lock(hashtext($1))",
      "CREATE INDEX CONCURRENTLY example ON t (c)",
    ]);
    expect(wire.httpQueries).toEqual([]);
  });
});
