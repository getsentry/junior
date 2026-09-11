import { SpanKind } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { finish, span, startSpanManual } = vi.hoisted(() => {
  const finish = vi.fn();
  const span = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    finish,
    span,
    startSpanManual: vi.fn(
      (
        _options: unknown,
        callback: (
          span: {
            setAttribute: (key: string, value: unknown) => unknown;
            setStatus: (status: unknown) => unknown;
          },
          finish: () => void,
        ) => unknown,
      ) => callback(span, finish),
    ),
  };
});

vi.mock("@/chat/sentry", () => ({ startSpanManual }));

import { traceQueries } from "@/db/tracing";

const OPTIONS = {
  connectionString: "postgres://private@example.test:6432/junior",
  driver: "neon" as const,
};

describe("SQL tracing", () => {
  beforeEach(() => {
    finish.mockClear();
    span.setAttribute.mockClear();
    span.setStatus.mockClear();
    startSpanManual.mockClear();
  });

  it("adds OpenTelemetry query metadata without changing parameters", async () => {
    const result = Promise.resolve({ rows: [{ id: "1" }] });
    const queryClient = vi.fn((_query: unknown) => result);
    const client = { query: queryClient };
    const traced = traceQueries(client, OPTIONS);
    const query = {
      text: "  select * from junior_conversations where id = $1 and kind = 'private-kind'",
      values: ["private-id"],
    };

    await expect(traced.query(query)).resolves.toEqual({ rows: [{ id: "1" }] });

    expect(queryClient).toHaveBeenCalledWith(query);
    expect(startSpanManual).toHaveBeenCalledWith(
      {
        name: "select junior_conversations",
        op: "db.query",
        kind: SpanKind.CLIENT,
        onlyIfParent: true,
        attributes: {
          "app.db.driver": "neon",
          "db.collection.name": "junior_conversations",
          "db.namespace": "junior",
          "db.operation.name": "select",
          "db.query.summary": "select junior_conversations",
          "db.query.text":
            "select * from junior_conversations where id = $1 and kind = ?",
          "db.system.name": "postgresql",
          "server.address": "example.test",
          "server.port": 6432,
        },
      },
      expect.any(Function),
    );
    expect(finish).toHaveBeenCalledOnce();
    expect(JSON.stringify(startSpanManual.mock.calls[0]?.[0])).not.toContain(
      "private-id",
    );
    expect(JSON.stringify(startSpanManual.mock.calls[0]?.[0])).not.toContain(
      "private",
    );
  });

  it("replaces literals and comments in non-parameterized query text", async () => {
    const client = {
      query: vi.fn((..._args: unknown[]) =>
        Promise.resolve({
          rows: [],
        }),
      ),
    };
    const traced = traceQueries(client, OPTIONS);

    await traced.query(
      `UPDATE "users--active" SET email = E'private\\'--value@example.test', active = true WHERE id = 42 -- secret`,
    );

    expect(startSpanManual.mock.calls[0]?.[0]).toMatchObject({
      name: 'UPDATE "users--active"',
      attributes: {
        "db.query.summary": 'UPDATE "users--active"',
        "db.query.text":
          'UPDATE "users--active" SET email = ?, active = ? WHERE id = ?',
      },
    });
  });

  it("uses the outer operation and records stored procedures", async () => {
    const cteClient = {
      query: vi.fn((..._args: unknown[]) => Promise.resolve({ rows: [] })),
    };
    await traceQueries(cteClient, OPTIONS).query(
      "WITH recent AS (SELECT * FROM events) SELECT EXTRACT(DAY FROM created_at) FROM conversations",
    );

    expect(startSpanManual.mock.calls[0]?.[0]).toMatchObject({
      name: "SELECT conversations",
      attributes: {
        "db.collection.name": "conversations",
        "db.operation.name": "SELECT",
        "db.query.summary": "SELECT conversations",
      },
    });

    const callClient = {
      query: vi.fn((..._args: unknown[]) => Promise.resolve({ rows: [] })),
    };
    await traceQueries(callClient, OPTIONS).query(
      "CALL public.refresh_stats() ",
    );

    expect(startSpanManual.mock.calls[1]?.[0]).toMatchObject({
      name: "CALL public.refresh_stats",
      attributes: {
        "db.operation.name": "CALL",
        "db.query.summary": "CALL public.refresh_stats",
        "db.stored_procedure.name": "public.refresh_stats",
      },
    });
    expect(startSpanManual.mock.calls[1]?.[0]).not.toHaveProperty(
      "attributes.db.collection.name",
    );

    const transactionClient = {
      query: vi.fn((..._args: unknown[]) => Promise.resolve({ rows: [] })),
    };
    await traceQueries(transactionClient, OPTIONS).query(
      "ROLLBACK TO SAVEPOINT s1",
    );

    expect(startSpanManual.mock.calls[2]?.[0]).toMatchObject({
      name: "ROLLBACK",
      attributes: {
        "db.operation.name": "ROLLBACK",
        "db.query.summary": "ROLLBACK",
      },
    });
  });

  it("records PostgreSQL failures and keeps the original rejection", async () => {
    const error = Object.assign(new Error("private database detail"), {
      code: "57014",
    });
    const client = {
      query: vi.fn((..._args: unknown[]) => Promise.reject(error)),
    };
    const traced = traceQueries(client, OPTIONS);

    await expect(traced.query("SELECT pg_sleep(1)")).rejects.toBe(error);

    expect(span.setAttribute).toHaveBeenCalledWith("error.type", "57014");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "db.response.status_code",
      "57014",
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(finish).toHaveBeenCalledOnce();
    expect(JSON.stringify(startSpanManual.mock.calls[0]?.[0])).not.toContain(
      "private database detail",
    );
  });

  it("finishes callback queries and records callback errors", async () => {
    const callback = vi.fn();
    const error = Object.assign(new Error("query failed"), { code: "42P01" });
    const client = {
      query: vi.fn(
        (_text: string, wrappedCallback: (...args: unknown[]) => void) => {
          wrappedCallback(error);
        },
      ),
    };
    const traced = traceQueries(client, OPTIONS);

    traced.query("SELECT 1", callback);

    expect(callback).toHaveBeenCalledWith(error);
    expect(span.setAttribute).toHaveBeenCalledWith("error.type", "42P01");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "db.response.status_code",
      "42P01",
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(finish).toHaveBeenCalledOnce();
  });
});
