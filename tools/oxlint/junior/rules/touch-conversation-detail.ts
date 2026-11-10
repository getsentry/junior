import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

// Tables that the Conversation detail report reads. Keep this list in sync
// with `readConversationDetail`. The status reads Review items.
const detailTables = new Set([
  "juniorAttachments",
  "juniorConversationAnnotations",
  "juniorConversationBriefs",
  "juniorConversationEvents",
  "juniorConversationParticipants",
  "juniorConversations",
  "juniorReviewItems",
]);
const detailTableNames = [
  "junior_attachments",
  "junior_conversation_annotations",
  "junior_conversation_briefs",
  "junior_conversation_events",
  "junior_conversation_participants",
  "junior_conversations",
  "junior_review_items",
];
const writeMethods = new Set(["delete", "insert", "update"]);
const touchFunction = "touchConversationDetail";
const touchCte = "conversationDetailTouch";
const versionKey = "detailVersion";
const rawWritePrefix = /\b(?:insert\s+into|update|delete\s+from)\s*"?$/i;
const rawWriteNamed = new RegExp(
  String.raw`\b(?:insert\s+into|update|delete\s+from)\s+"?(?:${detailTableNames.join("|")})\b`,
  "i",
);

type Write = { node: ESTree.Node; scope: ESTree.Node | null; end: number };

function propertyName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.property.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : null;
}

function enclosingFunction(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** Return each `.method(...)` call chained onto a query builder call. */
function chainedCalls(
  call: ESTree.CallExpression,
): Array<{ name: string; call: ESTree.CallExpression }> {
  const calls: Array<{ name: string; call: ESTree.CallExpression }> = [];
  let current: ESTree.Node = call;
  while (
    current.parent?.type === "MemberExpression" &&
    current.parent.object === current &&
    current.parent.parent?.type === "CallExpression" &&
    current.parent.parent.callee === current.parent
  ) {
    const name = propertyName(current.parent);
    current = current.parent.parent;
    if (name) calls.push({ name, call: current });
  }
  return calls;
}

function objectHasKey(node: ESTree.Node | undefined, key: string): boolean {
  if (node?.type !== "ObjectExpression") return false;
  return node.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === key) ||
        (property.key.type === "Literal" && property.key.value === key)),
  );
}

function objectProperty(
  node: ESTree.Node | undefined,
  key: string,
): ESTree.Node | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (const property of node.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === key
    ) {
      return property.value;
    }
  }
  return undefined;
}

/**
 * Return the calls made on a builder, through its chain or through the
 * variable that holds it, as in `const insert = db.insert(t); insert.x()`.
 */
function builderCalls(
  context: Context,
  call: ESTree.CallExpression,
): Array<{ name: string; call: ESTree.CallExpression }> {
  const calls = chainedCalls(call);
  const top: ESTree.Node = calls.at(-1)?.call ?? call;
  if (top.parent?.type !== "VariableDeclarator" || top.parent.init !== top) {
    return calls;
  }
  for (const variable of context.sourceCode.getDeclaredVariables(top.parent)) {
    for (const reference of variable.references) {
      const member = reference.identifier.parent;
      const used = member?.parent;
      if (
        member?.type !== "MemberExpression" ||
        used?.type !== "CallExpression"
      )
        continue;
      const name = propertyName(member);
      if (name && used.callee === member) calls.push({ name, call: used });
    }
  }
  return calls;
}

/** Report whether a write is built on `db.with(conversationDetailTouch(...))`. */
function carriesTouchCte(call: ESTree.CallExpression): boolean {
  const builder =
    call.callee.type === "MemberExpression" ? call.callee.object : null;
  return (
    builder?.type === "CallExpression" &&
    propertyName(builder.callee) === "with" &&
    builder.arguments.some(
      (argument) =>
        argument.type === "CallExpression" &&
        argument.callee.type === "Identifier" &&
        argument.callee.name === touchCte,
    )
  );
}

/**
 * A `juniorConversations` write that advances `detailVersion` itself needs no
 * separate touch. A plain insert creates a row whose version starts at zero,
 * and detail reads count the rows of a subtree.
 */
function conversationWriteBumpsItself(
  context: Context,
  method: string,
  call: ESTree.CallExpression,
): boolean {
  const calls = builderCalls(context, call);
  if (method === "update") {
    const set = calls.find((item) => item.name === "set");
    return objectHasKey(set?.call.arguments[0], versionKey);
  }
  if (method === "insert") {
    return calls
      .filter((item) => item.name === "onConflictDoUpdate")
      .every((upsert) =>
        objectHasKey(
          objectProperty(upsert.call.arguments[0], "set"),
          versionKey,
        ),
      );
  }
  return false;
}

/** Require each detail table write to advance the Conversation detail version. */
export const touchConversationDetailRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require writes to tables that the Conversation detail report reads to advance the Conversation detail version.",
    },
    messages: {
      missingTouch:
        "This write changes the Conversation detail report. Build it on `db.with(conversationDetailTouch(db, ids))`, call `touchConversationDetail` after it in the same function, or set `detailVersion` on a `juniorConversations` write. Otherwise open detail pages keep serving the old report.",
    },
  },
  create(context) {
    const writes: Write[] = [];
    const touches: Array<{ scope: ESTree.Node | null; start: number }> = [];

    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === touchFunction
        ) {
          touches.push({
            scope: enclosingFunction(node),
            start: node.range[0],
          });
          return;
        }
        const method = propertyName(node.callee);
        const table = node.arguments[0];
        if (
          !method ||
          !writeMethods.has(method) ||
          table?.type !== "Identifier"
        )
          return;
        if (!detailTables.has(table.name)) return;
        if (carriesTouchCte(node)) return;
        if (
          table.name === "juniorConversations" &&
          conversationWriteBumpsItself(context, method, node)
        ) {
          return;
        }
        const chain = chainedCalls(node);
        const end = (chain.at(-1)?.call ?? node).range[1];
        writes.push({ node, scope: enclosingFunction(node), end });
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        const { quasis, expressions } = node.quasi;
        const writesTable =
          quasis.some((quasi) => rawWriteNamed.test(quasi.value.raw)) ||
          expressions.some((expression, index) => {
            const before = quasis[index]?.value.raw ?? "";
            return (
              expression.type === "Identifier" &&
              detailTables.has(expression.name) &&
              rawWritePrefix.test(before)
            );
          });
        if (writesTable) {
          writes.push({
            node,
            scope: enclosingFunction(node),
            end: node.range[1],
          });
        }
      },
      "Program:exit"() {
        for (const write of writes) {
          const touched = touches.some(
            (touch) => touch.scope === write.scope && touch.start > write.end,
          );
          if (!touched)
            context.report({ node: write.node, messageId: "missingTouch" });
        }
      },
    };
  },
});
