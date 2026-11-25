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
  FieldNode,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from "graphql";

// graphql-js loads lazily, so this file compares `kind` with its stable string
// values instead of importing the `Kind` enum at startup.
/* oxlint-disable typescript/no-unsafe-enum-comparison */

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
    // oxlint-disable-next-line no-await-in-loop -- Stop at the first entry that cannot be read.
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
  const { operationName, query, variables } = entry as Record<string, unknown>;
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
  const connectionRequests = countConnectionRequests(
    operation,
    fragments,
    variables,
  );
  return {
    ...(connectionRequests !== undefined ? { connectionRequests } : undefined),
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

/**
 * Count the connection requests of an operation: each field with a `first`
 * or `last` page size counts once for each item that the page sizes above it
 * can return. Returns undefined when a page size is not an integer literal or
 * an integer variable.
 *
 * The count is linear in the items above a selection, so each fragment is
 * counted once and reused, and repeated spreads cannot make it slow.
 */
function countConnectionRequests(
  operation: OperationDefinitionNode,
  fragments: Fragments,
  variables: unknown,
): number | undefined {
  const values = integerVariables(operation, variables);
  const counted = new Map<string, number | undefined>();
  const count = (selectionSet: SelectionSetNode): number | undefined => {
    let total = 0;
    for (const selection of selectionSet.selections) {
      let inner: number | undefined;
      if (selection.kind === "Field") {
        inner = countField(selection);
      } else if (selection.kind === "InlineFragment") {
        inner = count(selection.selectionSet);
      } else {
        const name = selection.name.value;
        if (!counted.has(name)) {
          // A cycle counts as empty here. GraphQL rejects it before it runs.
          counted.set(name, 0);
          const fragment = fragments.get(name);
          counted.set(name, fragment ? count(fragment.selectionSet) : 0);
        }
        inner = counted.get(name);
      }
      if (inner === undefined) return undefined;
      total += inner;
    }
    return total;
  };
  const countField = (field: FieldNode): number | undefined => {
    const below = field.selectionSet ? count(field.selectionSet) : 0;
    if (below === undefined) return undefined;
    const pageSizes = (field.arguments ?? []).filter(
      (arg) => arg.name.value === "first" || arg.name.value === "last",
    );
    if (pageSizes.length === 0) return below;
    let pageSize = 0;
    for (const arg of pageSizes) {
      const value =
        arg.value.kind === "IntValue"
          ? Number.parseInt(arg.value.value, 10)
          : arg.value.kind === "Variable"
            ? values.get(arg.value.name.value)
            : undefined;
      if (value === undefined) return undefined;
      pageSize = Math.max(pageSize, value);
    }
    // One request for this connection, then the requests below it for each
    // item of its page.
    return 1 + pageSize * below;
  };
  return count(operation.selectionSet);
}

/** Integer variable values of a request, with the operation's defaults. */
function integerVariables(
  operation: OperationDefinitionNode,
  variables: unknown,
): Map<string, number> {
  const given = new Map<string, unknown>(
    variables && typeof variables === "object" && !Array.isArray(variables)
      ? Object.entries(variables)
      : [],
  );
  const values = new Map<string, number>();
  for (const definition of operation.variableDefinitions ?? []) {
    const name = definition.variable.name.value;
    const value = given.get(name);
    if (typeof value === "number" && Number.isInteger(value)) {
      values.set(name, value);
    } else if (
      value === undefined &&
      definition.defaultValue?.kind === "IntValue"
    ) {
      values.set(name, Number.parseInt(definition.defaultValue.value, 10));
    }
  }
  return values;
}
