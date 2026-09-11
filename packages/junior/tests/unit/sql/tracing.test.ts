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
      text: "  select * from junior_conversations where id = $1",
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
          "db.query.text": "select * from junior_conversations where id = $1",
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
      "UPDATE users SET email = 'private--value@example.test', active = true WHERE id = 42 -- secret",
    );

    expect(startSpanManual.mock.calls[0]?.[0]).toMatchObject({
      name: "UPDATE users",
      attributes: {
        "db.collection.name": "users",
        "db.query.summary": "UPDATE users",
        "db.query.text": "UPDATE users SET email = ?, active = ? WHERE id = ?",
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

  it("finishes callback queries after the callback runs", async () => {
    const callback = vi.fn();
    const client = {
      query: vi.fn(
        (_text: string, wrappedCallback: (...args: unknown[]) => void) => {
          wrappedCallback(null, { rows: [] });
        },
      ),
    };
    const traced = traceQueries(client, OPTIONS);

    traced.query("SELECT 1", callback);

    expect(callback).toHaveBeenCalledWith(null, { rows: [] });
    expect(finish).toHaveBeenCalledOnce();
  });
});
