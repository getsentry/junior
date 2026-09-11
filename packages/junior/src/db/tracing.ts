import { SpanKind } from "@opentelemetry/api";
import * as Sentry from "@/chat/sentry";

const traced = Symbol("junior.db.traced");
const MAX_QUERY_TEXT_LENGTH = 10_000;
const MAX_QUERY_SUMMARY_LENGTH = 255;

interface QueryClient {
  [traced]?: true;
  query: (...args: any[]) => unknown;
}

interface DatabaseConnectionAttributes {
  "db.namespace"?: string;
  "server.address"?: string;
  "server.port"?: number;
}

interface QueryDetails {
  collection?: string;
  operation?: string;
  summary?: string;
  text?: string;
}

const SQL_OPERATION =
  /\b(ALTER|CALL|CREATE|DELETE|DROP|INSERT|MERGE|SELECT|TRUNCATE|UPDATE)\b/i;
const SQL_TARGET: Record<string, RegExp> = {
  ALTER: /\bALTER\s+(?:TABLE\s+)?([^\s(;]+)/i,
  CALL: /\bCALL\s+([^\s(;]+)/i,
  CREATE:
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)/i,
  DELETE: /\bDELETE\s+FROM\s+([^\s(;]+)/i,
  DROP: /\bDROP\s+(?:TABLE|INDEX|VIEW)\s+(?:IF\s+EXISTS\s+)?([^\s(;]+)/i,
  INSERT: /\bINSERT\s+INTO\s+([^\s(;]+)/i,
  MERGE: /\bMERGE\s+INTO\s+([^\s(;]+)/i,
  SELECT: /\bFROM\s+([^\s(;]+)/i,
  TRUNCATE: /\bTRUNCATE\s+(?:TABLE\s+)?([^\s(;]+)/i,
  UPDATE: /\bUPDATE\s+([^\s(;]+)/i,
};

function queryText(query: unknown): string | undefined {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object" || !("text" in query)) {
    return undefined;
  }
  return typeof query.text === "string" ? query.text : undefined;
}

function hasQueryParameters(args: unknown[], text: string): boolean {
  const query = args[0];
  const configValues =
    query && typeof query === "object" && "values" in query
      ? query.values
      : undefined;
  const argumentValues = Array.isArray(args[1]) ? args[1] : undefined;
  return (
    /\$\d+\b/.test(text) ||
    (Array.isArray(configValues) && configValues.length > 0) ||
    (argumentValues?.length ?? 0) > 0
  );
}

function safeSqlText(text: string, sanitizeLiterals: boolean): string {
  let safe = "";
  for (let index = 0; index < text.length; ) {
    if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      safe += " ";
      index = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      safe += " ";
      index = end === -1 ? text.length : end + 2;
      continue;
    }

    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
      text.slice(index),
    )?.[0];
    if (dollarTag) {
      const end = text.indexOf(dollarTag, index + dollarTag.length);
      const next = end === -1 ? text.length : end + dollarTag.length;
      safe += sanitizeLiterals ? "?" : text.slice(index, next);
      index = next;
      continue;
    }

    const stringPrefix = /^(?:E|U&|B|X)?'/i.exec(text.slice(index))?.[0];
    if (stringPrefix) {
      let end = index + stringPrefix.length;
      while (end < text.length) {
        if (text[end] !== "'") {
          end += 1;
          continue;
        }
        if (text[end + 1] === "'") {
          end += 2;
          continue;
        }
        end += 1;
        break;
      }
      safe += sanitizeLiterals ? "?" : text.slice(index, end);
      index = end;
      continue;
    }

    safe += text[index];
    index += 1;
  }

  if (!sanitizeLiterals) return safe;
  return safe
    .replace(/\b(?:TRUE|FALSE)\b/gi, "?")
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, "?");
}

function normalizeQueryText(text: string, parameterized: boolean): string {
  return safeSqlText(text, !parameterized)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_TEXT_LENGTH);
}

function collectionFromTarget(target: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(
    target,
  )
    ? target
    : undefined;
}

function detailsFromQuery(args: unknown[]): QueryDetails {
  const rawText = queryText(args[0]);
  if (!rawText) return {};

  const text = normalizeQueryText(rawText, hasQueryParameters(args, rawText));
  const operation = SQL_OPERATION.exec(text)?.[1];
  const target = operation
    ? SQL_TARGET[operation.toUpperCase()]?.exec(text)?.[1]
    : undefined;
  const collection = target ? collectionFromTarget(target) : undefined;
  const summary = [operation, target].filter(Boolean).join(" ");

  return {
    collection,
    operation,
    summary: summary ? summary.slice(0, MAX_QUERY_SUMMARY_LENGTH) : undefined,
    text: text || undefined,
  };
}

function connectionAttributes(
  connectionString: string,
): DatabaseConnectionAttributes {
  try {
    const url = new URL(connectionString);
    const namespace = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const port = url.port ? Number(url.port) : undefined;
    return {
      ...(namespace ? { "db.namespace": namespace } : undefined),
      ...(url.hostname ? { "server.address": url.hostname } : undefined),
      ...(port && port !== 5432 ? { "server.port": port } : undefined),
    };
  } catch {
    return {};
  }
}

function responseStatusCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" || typeof error.code === "number"
    ? String(error.code)
    : undefined;
}

function errorType(error: unknown): string {
  return (
    responseStatusCode(error) ??
    (error instanceof Error ? error.name : typeof error)
  );
}

function markFailed(span: Sentry.Span, error: unknown): void {
  const statusCode = responseStatusCode(error);
  span.setAttribute("error.type", statusCode ?? errorType(error));
  if (statusCode) {
    span.setAttribute("db.response.status_code", statusCode);
  }
  span.setStatus({ code: 2 });
}

/** Add OpenTelemetry database client spans to an owned PostgreSQL query client. */
export function traceQueries<T extends QueryClient>(
  client: T,
  options: {
    connectionString: string;
    driver: "neon" | "postgres";
  },
): T {
  if (client[traced]) return client;
  client[traced] = true;

  const query = client.query.bind(client);
  const connection = connectionAttributes(options.connectionString);
  client.query = ((...originalArgs: Parameters<T["query"]>) => {
    const details = detailsFromQuery(originalArgs);
    const args = [...originalArgs];
    const callbackIndex =
      typeof args.at(-1) === "function" ? args.length - 1 : undefined;

    return Sentry.startSpanManual(
      {
        name: details.summary ?? details.operation ?? "postgresql",
        op: "db.query",
        kind: SpanKind.CLIENT,
        onlyIfParent: true,
        attributes: {
          "db.system.name": "postgresql",
          ...connection,
          ...(details.operation
            ? { "db.operation.name": details.operation }
            : undefined),
          ...(details.summary
            ? { "db.query.summary": details.summary }
            : undefined),
          ...(details.text ? { "db.query.text": details.text } : undefined),
          ...(details.collection
            ? { "db.collection.name": details.collection }
            : undefined),
          "app.db.driver": options.driver,
        },
      },
      (span, finish) => {
        if (callbackIndex !== undefined) {
          const callback = args[callbackIndex] as (
            error: unknown,
            ...callbackArgs: unknown[]
          ) => unknown;
          args[callbackIndex] = ((
            error: unknown,
            ...callbackArgs: unknown[]
          ) => {
            if (error) markFailed(span, error);
            finish();
            return callback(error, ...callbackArgs);
          }) as Parameters<T["query"]>[number];
        }

        try {
          const result = query(...args);
          if (callbackIndex !== undefined) return result;
          if (result && typeof result === "object" && "then" in result) {
            return Promise.resolve(result).then(
              (value) => {
                finish();
                return value;
              },
              (error: unknown) => {
                markFailed(span, error);
                finish();
                throw error;
              },
            );
          }
          finish();
          return result;
        } catch (error) {
          markFailed(span, error);
          finish();
          throw error;
        }
      },
    );
  }) as T["query"];
  return client;
}
