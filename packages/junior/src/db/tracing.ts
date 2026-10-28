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
  storedProcedure?: string;
  summary?: string;
  text?: string;
}

const SQL_OPERATIONS = new Set([
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "COMMIT",
  "COPY",
  "CREATE",
  "DELETE",
  "DROP",
  "EXPLAIN",
  "GRANT",
  "INSERT",
  "MERGE",
  "RELEASE",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SELECT",
  "SET",
  "SHOW",
  "TRUNCATE",
  "UPDATE",
  "VACUUM",
]);
const SQL_IDENTIFIER = String.raw`(?:(?:U&)?"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:(?:U&)?"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*))*`;

function targetPattern(prefix: string): RegExp {
  return new RegExp(`${prefix}(${SQL_IDENTIFIER})`, "i");
}

const SQL_TARGET: Record<string, RegExp> = {
  ALTER: targetPattern(String.raw`\bALTER\s+TABLE\s+`),
  CALL: targetPattern(String.raw`\bCALL\s+`),
  CREATE: targetPattern(
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?`,
  ),
  DELETE: targetPattern(String.raw`\bDELETE\s+FROM\s+`),
  DROP: targetPattern(
    String.raw`\bDROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?`,
  ),
  INSERT: targetPattern(String.raw`\bINSERT\s+INTO\s+`),
  MERGE: targetPattern(String.raw`\bMERGE\s+INTO\s+`),
  SELECT: targetPattern(String.raw`\bFROM\s+`),
  TRUNCATE: targetPattern(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?`),
  UPDATE: targetPattern(String.raw`\bUPDATE\s+`),
};

function queryText(query: unknown): string | undefined {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object" || !("text" in query)) {
    return undefined;
  }
  return typeof query.text === "string" ? query.text : undefined;
}

function safeSqlText(text: string): string {
  let safe = "";
  for (let index = 0; index < text.length; ) {
    if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      safe += " ";
      index = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (text.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (text.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      safe += " ";
      continue;
    }

    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
      text.slice(index),
    )?.[0];
    if (dollarTag) {
      const end = text.indexOf(dollarTag, index + dollarTag.length);
      index = end === -1 ? text.length : end + dollarTag.length;
      safe += "?";
      continue;
    }

    const identifierPrefix = /^(?:U&)?"/i.exec(text.slice(index))?.[0];
    if (identifierPrefix) {
      let end = index + identifierPrefix.length;
      while (end < text.length) {
        if (text[end] !== '"') {
          end += 1;
          continue;
        }
        if (text[end + 1] === '"') {
          end += 2;
          continue;
        }
        end += 1;
        break;
      }
      safe += text.slice(index, end);
      index = end;
      continue;
    }

    const stringPrefix = /^(?:E|U&|B|X)?'/i.exec(text.slice(index))?.[0];
    if (stringPrefix) {
      const supportsBackslashEscapes = /^E'/i.test(stringPrefix);
      let end = index + stringPrefix.length;
      while (end < text.length) {
        if (supportsBackslashEscapes && text[end] === "\\") {
          end += 2;
          continue;
        }
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
      safe += "?";
      index = end;
      continue;
    }

    const token =
      /^(?:TRUE|FALSE|NULL|0x[\da-f_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?[\d_]+)?)(?![A-Za-z0-9_$])/i.exec(
        text.slice(index),
      )?.[0];
    const previous = text[index - 1];
    if (token && (!previous || !/[A-Za-z0-9_$]/.test(previous))) {
      safe += "?";
      index += token.length;
      continue;
    }

    safe += text[index];
    index += 1;
  }

  return safe;
}

function normalizeQueryText(text: string): string {
  return safeSqlText(text.slice(0, MAX_QUERY_TEXT_LENGTH))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_TEXT_LENGTH);
}

function operationFromText(
  text: string,
): { index: number; name: string } | undefined {
  const tokens = /(?:U&)?"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*|[()]/gi;
  let depth = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "(") {
      depth += 1;
    } else if (token === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && !token.includes('"')) {
      if (SQL_OPERATIONS.has(token.toUpperCase())) {
        return { index: match.index, name: token };
      }
    }
  }
  return undefined;
}

function targetFromOperation(
  operation: string,
  text: string,
): string | undefined {
  if (operation.toUpperCase() !== "SELECT") {
    return SQL_TARGET[operation.toUpperCase()]?.exec(text)?.[1];
  }

  const tokens = /(?:U&)?"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*|[()]/gi;
  let depth = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "(") {
      depth += 1;
    } else if (token === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.toUpperCase() === "FROM") {
      const targetText = text.slice(match.index + token.length).trimStart();
      return new RegExp(`^(${SQL_IDENTIFIER})`, "i").exec(targetText)?.[1];
    }
  }
  return undefined;
}

function querySummary(
  operation: string | undefined,
  target: string | undefined,
): string | undefined {
  if (!operation) return undefined;
  const summary = target ? `${operation} ${target}` : operation;
  return summary.length <= MAX_QUERY_SUMMARY_LENGTH ? summary : operation;
}

function detailsFromQuery(args: unknown[]): QueryDetails {
  const rawText = queryText(args[0]);
  if (!rawText) return {};

  const text = normalizeQueryText(rawText);
  const operationMatch = operationFromText(text);
  const operation = operationMatch?.name;
  const operationText = operationMatch ? text.slice(operationMatch.index) : "";
  const target = operation
    ? targetFromOperation(operation, operationText)
    : undefined;
  const summary = querySummary(operation, target);
  const isCall = operation?.toUpperCase() === "CALL";

  return {
    collection: isCall ? undefined : target,
    operation,
    storedProcedure: isCall ? target : undefined,
    summary,
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
  if (statusCode && /^[0-9A-Z]{5}$/i.test(statusCode)) {
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
          ...(details.storedProcedure
            ? { "db.stored_procedure.name": details.storedProcedure }
            : undefined),
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
