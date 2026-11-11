/**
 * GraphQL request reading for egress hooks.
 *
 * A GraphQL POST names its operation in a JSON body. The host parses the
 * document with graphql-js and gives plugins the selected operation, so a
 * plugin can judge a request without parsing GraphQL. Reading fails closed:
 * a body that the host cannot read is `unreadable`, never a query.
 *
 * graphql-js loads on the first GraphQL request, not at startup.
 */
import type {
  PluginGraphqlField,
  PluginGraphqlOperation,
  PluginGraphqlRequest,
  PluginGraphqlUnreadableReason,
} from "@sentry/junior-plugin-api";
import type {
  DocumentNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from "graphql";

/** Largest GraphQL body that the host reads before it issues credentials. */
const GRAPHQL_BODY_LIMIT_BYTES = 64 * 1024;

type Fragments = Map<string, FragmentDefinitionNode>;

/** Match a GraphQL request whose body names the operation. */
export function isGraphqlPost(method: string, upstreamUrl: URL): boolean {
  return (
    method.toUpperCase() === "POST" &&
    upstreamUrl.pathname.toLowerCase().endsWith("/graphql")
  );
}

function unreadable(
  reason: PluginGraphqlUnreadableReason,
): PluginGraphqlRequest {
  return { kind: "unreadable", reason };
}

/**
 * Read the operations of a GraphQL POST body.
 *
 * A JSON array is a batch. One unreadable entry makes the whole batch
 * unreadable.
 */
export async function readGraphqlRequest(
  body: ArrayBuffer | undefined,
): Promise<PluginGraphqlRequest> {
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return unreadable("gzip");
  }
  if (bytes.byteLength > GRAPHQL_BODY_LIMIT_BYTES) {
    return unreadable("too-large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return unreadable("json");
  }
  if (!Array.isArray(parsed)) {
    const operation = await readOperation(parsed);
    return typeof operation === "string"
      ? unreadable(operation)
      : { kind: "operation", operation };
  }
  const operations: PluginGraphqlOperation[] = [];
  for (const entry of parsed) {
    const operation = await readOperation(entry);
    if (typeof operation === "string") {
      return unreadable(operation);
    }
    operations.push(operation);
  }
  return { kind: "batch", operations };
}

async function readOperation(
  entry: unknown,
): Promise<PluginGraphqlOperation | PluginGraphqlUnreadableReason> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "json";
  }
  const { operationName, query } = entry as Record<string, unknown>;
  if (typeof query !== "string") {
    return "query";
  }
  if (
    operationName !== undefined &&
    operationName !== null &&
    typeof operationName !== "string"
  ) {
    return "operation";
  }
  const { parse } = await import("graphql");
  let document: DocumentNode;
  try {
    document = parse(query, { noLocation: true });
  } catch {
    return "document";
  }
  const fragments: Fragments = new Map();
  const operations: OperationDefinitionNode[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === "OperationDefinition") {
      operations.push(definition);
    } else if (definition.kind === "FragmentDefinition") {
      // Two fragments with one name leave the spread ambiguous.
      if (fragments.has(definition.name.value)) {
        return "document";
      }
      fragments.set(definition.name.value, definition);
    }
  }
  // Same selection rule as graphql-js `getOperationAST`.
  const operation = operationName
    ? operations.find((candidate) => candidate.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation) {
    return "operation";
  }
  const fields = new Map<string, PluginGraphqlField>();
  const rootFields: string[] = [];
  if (
    !collectFields(operation.selectionSet, fragments, new Set(), fields) ||
    !collectRootFields(operation.selectionSet, fragments, new Set(), rootFields)
  ) {
    return "document";
  }
  return {
    fields: [...fields.values()],
    ...(operation.name ? { name: operation.name.value } : undefined),
    rootFields,
    type: operation.operation,
  };
}

/** Add each distinct field at any depth. Each fragment is read once. */
function collectFields(
  selectionSet: SelectionSetNode,
  fragments: Fragments,
  seen: Set<string>,
  fields: Map<string, PluginGraphqlField>,
): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === "Field") {
      const name = selection.name.value;
      const args = (selection.arguments ?? []).map((arg) => arg.name.value);
      const key = [name, ...args].join("\0");
      if (!fields.has(key)) {
        fields.set(key, { arguments: args, name });
      }
      if (
        selection.selectionSet &&
        !collectFields(selection.selectionSet, fragments, seen, fields)
      ) {
        return false;
      }
      continue;
    }
    const inner = fragmentSelectionSet(selection, fragments, seen);
    if (inner === false) {
      return false;
    }
    if (inner && !collectFields(inner, fragments, seen, fields)) {
      return false;
    }
  }
  return true;
}

/** Add the operation root fields, through fragments. */
function collectRootFields(
  selectionSet: SelectionSetNode,
  fragments: Fragments,
  seen: Set<string>,
  rootFields: string[],
): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === "Field") {
      rootFields.push(selection.name.value);
      continue;
    }
    const inner = fragmentSelectionSet(selection, fragments, seen);
    if (inner === false) {
      return false;
    }
    if (inner && !collectRootFields(inner, fragments, seen, rootFields)) {
      return false;
    }
  }
  return true;
}

/**
 * Return the selections of an inline fragment or a fragment spread.
 *
 * Returns undefined for a fragment already read, which also stops cycles, and
 * false for a spread of an undefined fragment.
 */
function fragmentSelectionSet(
  selection: FragmentSpreadNode | InlineFragmentNode,
  fragments: Fragments,
  seen: Set<string>,
): SelectionSetNode | undefined | false {
  if (selection.kind === "InlineFragment") {
    return selection.selectionSet;
  }
  const name = selection.name.value;
  if (seen.has(name)) {
    return undefined;
  }
  seen.add(name);
  return fragments.get(name)?.selectionSet ?? false;
}
