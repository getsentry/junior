import type { CredentialIntent } from "@/chat/credentials/broker";

const HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_GRAPHQL_INTENT_BODY_BYTES = 64 * 1024;

type GraphqlOperation = {
  name?: string;
  type: "mutation" | "query" | "subscription";
};

function githubSmartHttpIntent(upstreamUrl: URL): CredentialIntent | undefined {
  const service = upstreamUrl.searchParams.get("service");
  if (service === "git-receive-pack") {
    return "write";
  }
  if (service === "git-upload-pack") {
    return "read";
  }

  const pathname = upstreamUrl.pathname.toLowerCase();
  if (pathname.endsWith("/git-receive-pack")) {
    return "write";
  }
  if (pathname.endsWith("/git-upload-pack")) {
    return "read";
  }

  return undefined;
}

function skipGraphqlIgnored(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === "#" || /\s|,/.test(char ?? "")) {
      cursor += 1;
      if (char === "#") {
        while (cursor < input.length && input[cursor] !== "\n") {
          cursor += 1;
        }
      }
      continue;
    }
    break;
  }
  return cursor;
}

function readGraphqlName(
  input: string,
  index: number,
): { name: string; next: number } | undefined {
  const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(index));
  return match ? { name: match[0], next: index + match[0].length } : undefined;
}

function skipGraphqlString(input: string, index: number): number {
  if (input.startsWith('"""', index)) {
    const end = input.indexOf('"""', index + 3);
    return end === -1 ? input.length : end + 3;
  }

  let cursor = index + 1;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return input.length;
}

function skipGraphqlSelection(input: string, index: number): number {
  let cursor = index;
  let depth = 0;
  while (cursor < input.length) {
    cursor = skipGraphqlIgnored(input, cursor);
    const char = input[cursor];
    if (char === '"') {
      cursor = skipGraphqlString(input, cursor);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return input.length;
}

function skipGraphqlDefinition(input: string, index: number): number {
  let cursor = index;
  let parenDepth = 0;
  while (cursor < input.length) {
    cursor = skipGraphqlIgnored(input, cursor);
    const char = input[cursor];
    if (char === '"') {
      cursor = skipGraphqlString(input, cursor);
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "{" && parenDepth === 0) {
      return skipGraphqlSelection(input, cursor);
    }
    cursor += 1;
  }
  return input.length;
}

function parseGraphqlOperations(query: string): GraphqlOperation[] | undefined {
  const document = query.replace(/^\uFEFF/, "");
  const operations: GraphqlOperation[] = [];
  let cursor = skipGraphqlIgnored(document, 0);

  while (cursor < document.length) {
    cursor = skipGraphqlIgnored(document, cursor);
    const char = document[cursor];
    if (!char) {
      break;
    }
    if (char === "{") {
      operations.push({ type: "query" });
      cursor = skipGraphqlSelection(document, cursor);
      continue;
    }

    const token = readGraphqlName(document, cursor);
    if (!token) {
      return undefined;
    }
    cursor = token.next;

    if (
      token.name === "query" ||
      token.name === "mutation" ||
      token.name === "subscription"
    ) {
      cursor = skipGraphqlIgnored(document, cursor);
      const name = readGraphqlName(document, cursor);
      if (name) {
        cursor = name.next;
      }
      operations.push({ name: name?.name, type: token.name });
      cursor = skipGraphqlDefinition(document, cursor);
      continue;
    }

    if (token.name === "fragment") {
      cursor = skipGraphqlDefinition(document, cursor);
      continue;
    }

    return undefined;
  }

  return operations.length > 0 ? operations : undefined;
}

function graphqlIntentForOperation(
  operation: GraphqlOperation,
): CredentialIntent {
  return operation.type === "mutation" ? "write" : "read";
}

function graphqlOperationIntent(
  query: string,
  operationName?: string,
): CredentialIntent | undefined {
  const operations = parseGraphqlOperations(query);
  if (!operations) {
    return undefined;
  }

  if (operationName) {
    const selected = operations.find(
      (operation) => operation.name === operationName,
    );
    if (selected) {
      return graphqlIntentForOperation(selected);
    }
    return operations.some((operation) => operation.type === "mutation")
      ? "write"
      : "read";
  }

  if (operations.length === 1) {
    return graphqlIntentForOperation(operations[0]!);
  }
  return operations.some((operation) => operation.type === "mutation")
    ? "write"
    : "read";
}

function githubGraphqlIntent(
  upstreamUrl: URL,
  body: ArrayBuffer | undefined,
): CredentialIntent | undefined {
  if (
    !upstreamUrl.pathname.toLowerCase().endsWith("/graphql") ||
    body === undefined ||
    body.byteLength > MAX_GRAPHQL_INTENT_BODY_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const query = (parsed as { operationName?: unknown; query?: unknown })
      .query;
    const operationName = (
      parsed as { operationName?: unknown; query?: unknown }
    ).operationName;
    return typeof query === "string"
      ? graphqlOperationIntent(
          query,
          typeof operationName === "string" && operationName.trim()
            ? operationName
            : undefined,
        )
      : undefined;
  } catch {
    return undefined;
  }
}

/** Classify GitHub egress when the request URL and method are enough to avoid reading the body. */
export function githubSandboxEgressBodylessIntent(input: {
  method: string;
  upstreamUrl: URL;
}): CredentialIntent | undefined {
  const smartHttpIntent = githubSmartHttpIntent(input.upstreamUrl);
  if (smartHttpIntent) {
    return smartHttpIntent;
  }
  if (input.upstreamUrl.pathname.toLowerCase().endsWith("/graphql")) {
    return undefined;
  }
  return HTTP_READ_METHODS.has(input.method.toUpperCase()) ? "read" : "write";
}

/** Classify GitHub provider traffic so write OAuth is requested only when runtime evidence requires it. */
export function githubSandboxEgressIntent(input: {
  body?: ArrayBuffer;
  method: string;
  upstreamUrl: URL;
}): CredentialIntent {
  return (
    githubSandboxEgressBodylessIntent(input) ??
    githubGraphqlIntent(input.upstreamUrl, input.body) ??
    (HTTP_READ_METHODS.has(input.method.toUpperCase()) ? "read" : "write")
  );
}
