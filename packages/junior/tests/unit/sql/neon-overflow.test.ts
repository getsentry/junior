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
  clientsReady: 0,
  clientsClosed: 0,
  failNextConnect: false,
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
      const failed = wire.failNextConnect;
      wire.failNextConnect = false;
      setImmediate(() => {
        if (failed) {
          callback(new Error("connection refused"));
          return;
        }
        wire.clientsReady++;
        callback();
      });
    }
    async query(input: string | { text: string; rowMode?: string }) {
      const config = typeof input === "string" ? { text: input } : input;
      wire.websocketQueries.push(config.text);
      await new Promise((resolve) => setImmediate(resolve));
      if (config.text.includes("pg_try_advisory_lock")) {
        return { command: "SELECT", rowCount: 1, rows: [{ locked: true }] };
      }
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
      wire.clientsClosed++;
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

function createExecutor() {
  return createNeonJuniorSqlExecutor({
    connectionString: CONNECTION_STRING,
    statementTimeoutMs: 30_000,
  });
}

const POOL_IDLE_TIMEOUT_MS = 60_000;

describe("Neon pool overflow", () => {
  let executor: ReturnType<typeof createNeonJuniorSqlExecutor>;

  beforeEach(() => {
    wire.clientsOpened = 0;
    wire.clientsReady = 0;
    wire.clientsClosed = 0;
    wire.failNextConnect = false;
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
    executor = createExecutor();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await executor.close();
  });

  it("sends a burst wider than the idle clients over HTTP, then grows the pool", async () => {
    // The first query opens the pool's only client, as before.
    await executor.query("select 'warm'");
    expect(wire.clientsOpened).toBe(1);

    const burst = () =>
      Promise.all([
        executor.query<{ transport: string }>("select $1::text", ["a"]),
        executor.query<{ transport: string }>("select $1::text", ["b"]),
        executor
          .db()
          .select({ transport: juniorConversations.conversationId })
          .from(juniorConversations),
      ]);
    const results = await burst();

    expect(results.map((rows) => rows[0]?.transport)).toEqual([
      "websocket",
      "http",
      "http",
    ]);
    // Both row modes map over HTTP.
    expect(wire.httpQueries).toEqual([
      "select $1::text",
      'select "conversation_id" from "junior_conversations"',
    ]);

    // Each overflowed query opened a client in the background, so the next
    // batch of the same width runs on WebSocket.
    await vi.waitFor(() => expect(wire.clientsReady).toBe(3));
    expect((await burst()).map((rows) => rows[0]?.transport)).toEqual([
      "websocket",
      "websocket",
      "websocket",
    ]);
    expect(wire.clientsOpened).toBe(3);
    expect(wire.httpQueries).toHaveLength(2);
  });

  it("never grows the pool past max", async () => {
    await executor.query("select 'warm'");
    const burst = () =>
      Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          executor.query<{ transport: string }>("select $1::int", [index]),
        ),
      );

    await burst();
    await vi.waitFor(() => expect(wire.clientsReady).toBe(10));
    const transports = (await burst()).map((rows) => rows[0]?.transport);

    expect(
      transports.filter((transport) => transport === "websocket"),
    ).toHaveLength(10);
    expect(wire.clientsOpened).toBe(10);
  });

  it("keeps a failed background connect from failing queries", async () => {
    await executor.query("select 'warm'");
    wire.failNextConnect = true;

    const [first, second] = await Promise.all([
      executor.query<{ transport: string }>("select 1"),
      executor.query<{ transport: string }>("select 2"),
    ]);
    expect([first[0]?.transport, second[0]?.transport]).toEqual([
      "websocket",
      "http",
    ]);
    await vi.waitFor(() => expect(wire.clientsOpened).toBe(2));

    // The pool still serves queries, and the next overflow grows it again.
    await Promise.all([executor.query("select 3"), executor.query("select 4")]);
    await vi.waitFor(() => expect(wire.clientsReady).toBe(2));
    expect(wire.clientsOpened).toBe(3);
  });

  it("opens one client again after every client idles out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await executor.query("select 'warm'");
    await Promise.all([executor.query("select 1"), executor.query("select 2")]);
    await vi.waitFor(() => expect(wire.clientsReady).toBe(2));

    vi.advanceTimersByTime(POOL_IDLE_TIMEOUT_MS);

    expect(wire.clientsClosed).toBe(2);
    await vi.waitFor(() => expect(wire.clientsReady).toBe(3));

    // The reopened client stays open past the next idle timeout.
    vi.advanceTimersByTime(POOL_IDLE_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(wire.clientsClosed).toBe(2);
    const [row] = await executor.query<{ transport: string }>("select 3");
    expect(row?.transport).toBe("websocket");
    expect(wire.clientsOpened).toBe(3);

    // Closing the pool removes the last client without opening another.
    const closing = executor;
    executor = createExecutor();
    await closing.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(wire.clientsClosed).toBe(3);
    expect(wire.clientsOpened).toBe(3);
  });

  it("tries one reconnect when it fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await executor.query("select 'warm'");
    await Promise.all([executor.query("select 1"), executor.query("select 2")]);
    await vi.waitFor(() => expect(wire.clientsReady).toBe(2));
    wire.failNextConnect = true;

    vi.advanceTimersByTime(POOL_IDLE_TIMEOUT_MS);

    await vi.waitFor(() => expect(wire.clientsOpened).toBe(3));
    await new Promise((resolve) => setImmediate(resolve));
    expect(wire.clientsOpened).toBe(3);
    // The empty pool opens its next client inline.
    const [row] = await executor.query<{ transport: string }>("select 3");
    expect(row?.transport).toBe("websocket");
    expect(wire.clientsOpened).toBe(4);
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
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      "CREATE INDEX CONCURRENTLY example ON t (c)",
    ]);
    expect(wire.httpQueries).toEqual([]);
  });
});
