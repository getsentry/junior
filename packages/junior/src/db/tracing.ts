import * as Sentry from "@/chat/sentry";

const traced = Symbol("junior.db.traced");

interface QueryClient {
  [traced]?: true;
  query: (...args: any[]) => unknown;
}

const SQL_OPERATION =
  /^[\s;]*(ALTER|CALL|CREATE|DELETE|DROP|INSERT|MERGE|SELECT|TRUNCATE|UPDATE)\b/i;

function operationFromQuery(query: unknown): string | undefined {
  const text =
    typeof query === "string"
      ? query
      : query && typeof query === "object" && "text" in query
        ? (query.text as unknown)
        : undefined;
  return typeof text === "string"
    ? SQL_OPERATION.exec(text)?.[1]?.toUpperCase()
    : undefined;
}

/** Add safe database spans to an owned PostgreSQL query client. */
export function traceQueries<T extends QueryClient>(
  client: T,
  driver: "neon" | "postgres",
): T {
  if (client[traced]) return client;
  client[traced] = true;

  const query = client.query.bind(client);
  client.query = ((...args: Parameters<T["query"]>) => {
    const operation = operationFromQuery(args[0]);
    return Sentry.startSpan(
      {
        name: operation ?? "postgresql",
        op: "db.query",
        onlyIfParent: true,
        attributes: {
          "db.system.name": "postgresql",
          ...(operation ? { "db.operation.name": operation } : undefined),
          "app.db.driver": driver,
        },
      },
      () => query(...args),
    );
  }) as T["query"];
  return client;
}
