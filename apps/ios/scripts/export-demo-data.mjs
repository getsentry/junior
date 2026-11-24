// Write the data of the app's built-in demo (`JuniorKit/Demo`) from the mock
// MCP server, so the demo shows the same mock data as the UI tests. Start the
// server first (`scripts/start-mock-server.sh`), then run:
//
//   node apps/ios/scripts/export-demo-data.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = process.env["JUNIOR_IOS_SERVER"] ?? "http://127.0.0.1:4317";
// `JuniorServer.demo`. Links in the data point at it instead of the mock.
const DEMO_ORIGIN = "https://demo.junior.invalid";
// `NOW` of the dashboard mock fixtures. The demo moves every time by the same
// amount, so the newest activity is recent when the demo starts.
const FIXTURE_NOW = "2026-08-07T12:00:00.000Z";
const output = fileURLToPath(
  new URL(
    "../Packages/JuniorKit/Sources/JuniorKit/Demo/demo-data.json",
    import.meta.url,
  ),
);

let nextId = 0;
async function call(name, args = {}) {
  const response = await fetch(`${server}/api/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer mock-access-token",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const { result, error } = await response.json();
  if (error) throw new Error(`${name}: ${error.message}`);
  if (result.isError) return undefined;
  return result.structuredContent;
}

async function allMessages(conversationId) {
  const messages = [];
  let before;
  do {
    const page = await call("listConversationMessages", {
      conversationId,
      limit: 50,
      ...(before ? { before } : undefined),
    });
    messages.unshift(...page.messages);
    before = page.nextCursor;
  } while (before);
  return messages;
}

async function conversation(conversationId, listed) {
  const state = await call("getConversation", { conversationId });
  if (!state) return undefined;
  return {
    conversation: state.conversation,
    messages: await allMessages(conversationId),
    pendingMessages: state.pendingMessages,
    authorization: state.authorization,
    listed,
  };
}

const feed = [
  ...(await call("searchConversations", {})).conversations,
  ...(await call("searchConversations", { status: "archived" })).conversations,
]
  // Filler rows that only test paging in the UI tests.
  .filter(
    ({ conversationId }) => !conversationId.startsWith("internal:history-"),
  );

const { items: inboxItems } = await call("searchInboxItems", { limit: 50 });
const automations = [];
for (let page = 1; ; page++) {
  const list = await call("searchAutomations", { page });
  for (const { id } of list.automations)
    automations.push(await call("getAutomation", { id }));
  if (list.automations.length === 0 || automations.length >= list.total) break;
}

// Inbox items and runs can open Conversations that the feed does not list.
const listed = new Set(feed.map(({ conversationId }) => conversationId));
const linked = new Set([
  ...inboxItems.flatMap(({ conversationIds }) => conversationIds),
  ...automations.flatMap(({ automation, runs }) => [
    automation.lastConversationId,
    ...runs.map(({ conversationId }) => conversationId),
  ]),
]);
const conversations = [];
for (const id of listed) conversations.push(await conversation(id, true));
for (const id of linked) {
  if (!id || listed.has(id)) continue;
  const found = await conversation(id, false);
  if (found) conversations.push(found);
}

const data = { now: FIXTURE_NOW, conversations, inboxItems, automations };
const json = JSON.stringify(data, null, 2).replaceAll(server, DEMO_ORIGIN);
await writeFile(output, `${json}\n`);
console.log(
  `Wrote ${conversations.length} conversations, ${inboxItems.length} inbox items, and ${automations.length} automations to ${output}`,
);
