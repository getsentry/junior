// The tools of the mock MCP server at `/api/mcp`. Each tool reads or writes
// the mock dashboard API in-process and maps its JSON to the result of the
// real tool in `packages/junior/src/api/mcp/tools`.
import { randomUUID } from "node:crypto";

/** Every MCP scope, in canonical order. */
export const MCP_SCOPES = [
  "conversations:read",
  "conversations:manage",
  "conversations:write",
  "inbox_items:read",
  "automations:read",
];

const RECENT_EVENT_LIMIT = 100;
const AFTER_EVENT_SCAN_LIMIT = 200;
const AFTER_MESSAGE_LIMIT = 20;
const EVENT_SCAN_LIMIT = 200;
const RECENT_RUN_LIMIT = 10;

// The dashboard mock has no reply notice: the Inbox item that a reply in a
// Conversation without a Location adds for its starter (`reply-notice.ts`).
// Its body is the preview of the latest reply.
const REPLY_NOTICE = {
  id: "qa-reply-dashboard-qa",
  kind: "notice",
  status: "open",
  title: "Dashboard QA edge cases",
  body: "I mean the empty, loading, and failed transcript states.",
  assignedToEveryone: false,
  assignees: [{ displayName: "Dashboard User" }],
  canAct: true,
  conversationIds: ["internal:dashboard-qa"],
  createdAt: "2026-08-07T07:00:58.000Z",
  updatedAt: "2026-08-07T07:01:09.000Z",
};

/** A tool error that the client model can read, like `mcpToolError`. */
class ToolError extends Error {}

const READ_ONLY = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};
const MANAGE = { ...READ_ONLY, readOnlyHint: false };
const DESTRUCTIVE = { ...MANAGE, destructiveHint: true };
const SEND = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

const conversationId = {
  type: "string",
  min: 1,
  description:
    "Conversation id from searchConversations or createConversation.",
};
const messageText = {
  type: "string",
  trim: true,
  min: 1,
  max: 32_000,
  description: "Message text.",
};
const conversationTitle = { type: "string", trim: true, min: 1, max: 200 };
const idempotencyKey = {
  type: "string",
  trim: true,
  min: 1,
  max: 200,
  optional: true,
  description:
    "Reuse the same key to retry without sending the message twice. Omit it to send a new message.",
};
const cursorParam = (description) => ({
  type: "string",
  min: 1,
  max: 1_000,
  optional: true,
  description,
});

/**
 * Build the mock MCP tools over the mock dashboard `app`. Tool state that
 * the dashboard mock does not keep (stopped Conversations and dropped
 * pending messages) lives here and `reset` clears it.
 */
export function createMockMcpTools({ app, origin }) {
  // Conversations that `stopConversation` stopped, until a person sends one.
  const stopped = new Set();
  // Conversations whose fixture pending messages were dropped.
  const droppedPending = new Set();

  const link = (path, id) => `${origin}/${path}/${encodeURIComponent(id)}`;
  const enc = encodeURIComponent;

  async function api(method, path, body) {
    const response = await app.fetch(
      new Request(`${origin}/api${path}`, {
        method,
        ...(body === undefined
          ? undefined
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      }),
    );
    const json = await response.json().catch(() => undefined);
    return { json, ok: response.ok, status: response.status };
  }

  // Shared API functions turn a client error into a tool error.
  function apiFailure(result) {
    if (result.status < 500 && typeof result.json?.error === "string") {
      return new ToolError(result.json.error);
    }
    return new Error(`Mock dashboard API answered ${result.status}.`);
  }

  async function apiJson(method, path, body) {
    const result = await api(method, path, body);
    if (!result.ok) throw apiFailure(result);
    return result.json;
  }

  async function readDetail(id, limit) {
    const result = await api("GET", `/conversations/${enc(id)}?limit=${limit}`);
    if (result.status === 404) return undefined;
    if (!result.ok) throw apiFailure(result);
    return result.json;
  }

  async function requireDetail(id, limit = RECENT_EVENT_LIMIT) {
    const detail = await readDetail(id, limit);
    if (!detail) throw new ToolError("Conversation not found.");
    return detail;
  }

  // Every event of a Conversation, oldest first. Mock details can page.
  async function readTranscript(id) {
    const detail = await requireDetail(id, 1_000);
    let events = detail.events;
    const seen = new Set();
    for (let cursor = detail.previousCursor; cursor && !seen.has(cursor);) {
      seen.add(cursor);
      const page = await api(
        "GET",
        `/conversations/${enc(id)}/events?before=${enc(cursor)}&limit=1000`,
      );
      if (!page.ok) break;
      events = [...page.json.events, ...events];
      cursor = page.json.previousCursor;
    }
    return { detail, events };
  }

  function encodeCursor(id, seq) {
    const payload = { conversationId: id, seq, version: 1 };
    return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.mock`;
  }

  function decodeCursor(id, cursor) {
    const [encoded, signature, extra] = cursor.split(".");
    if (!encoded || signature !== "mock" || extra !== undefined) return;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
      return payload.conversationId === id &&
        Number.isInteger(payload.seq) &&
        payload.seq >= -1
        ? payload.seq
        : undefined;
    } catch {
      return undefined;
    }
  }

  function mcpConversation(summary) {
    const id = summary.conversationId;
    return {
      conversationId: id,
      title: summary.displayTitle,
      summary: summary.summary,
      status: stopped.has(id) ? "done" : summary.status,
      turnActive: summary.turnActive && !stopped.has(id),
      treeState: summary.treeState,
      watching: summary.watching,
      surface: summary.surface,
      channelName: summary.channelNameRedacted
        ? undefined
        : summary.channelName,
      locationUrl: summary.locationUrl,
      startedAt: summary.startedAt,
      lastSeenAt: summary.lastSeenAt,
      archivedAt: summary.archivedAt ?? undefined,
      pinnedAt: summary.pinnedAt ?? undefined,
      url: link("conversations", id),
    };
  }

  function mcpAttachments(attachments) {
    return attachments?.length
      ? attachments.map(({ bytes, contentType, filename }) => ({
          bytes,
          contentType,
          filename,
        }))
      : undefined;
  }

  function mcpAuthor(identity) {
    return identity?.fullName ?? identity?.slackUserName ?? identity?.email;
  }

  function mcpMessages(events) {
    return events.flatMap((event) => {
      const data = event.data;
      if (data.type !== "message" || data.role === "system") return [];
      const text = data.text ?? "";
      const attachments = mcpAttachments(data.attachments);
      if (!text && !attachments) return [];
      return [
        {
          seq: event.seq,
          messageId: data.messageId,
          createdAt: event.createdAt,
          role: data.role,
          author: mcpAuthor(data.actorIdentity),
          text,
          attachments,
        },
      ];
    });
  }

  async function readPendingWork(id) {
    const result = await api(
      "GET",
      `/conversations/${enc(id)}/pending-messages`,
    );
    if (!result.ok) throw apiFailure(result);
    const report = result.json;
    const messages = droppedPending.has(id) ? [] : report.messages;
    const pendingMessages = messages.flatMap((message) =>
      message.text === undefined
        ? []
        : [
            {
              messageId: message.messageId,
              createdAt: message.createdAt,
              author: mcpAuthor(message.actorIdentity),
              text: message.text,
              attachments: mcpAttachments(message.attachments),
              delivery: message.delivery,
            },
          ],
    );
    const authorization = report.authorization;
    return {
      pendingMessages,
      ...(authorization
        ? {
            authorization: {
              label: authorization.label,
              url: authorization.authorizationUrl,
            },
          }
        : undefined),
    };
  }

  function messagesAfter(events, afterSeq) {
    const newer = events.filter((event) => event.seq > afterSeq);
    const page = newer.slice(0, AFTER_EVENT_SCAN_LIMIT);
    const scanned = mcpMessages(page);
    const messages = scanned.slice(0, AFTER_MESSAGE_LIMIT);
    const cut = scanned.length > messages.length;
    return {
      messages,
      hasMore: cut || newer.length > page.length,
      seq: cut ? messages.at(-1).seq : (page.at(-1)?.seq ?? afterSeq),
    };
  }

  function mcpInboxItem(item) {
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      body: item.body,
      question: item.request?.question,
      assignees: item.assignedToEveryone
        ? []
        : item.assignees.map((person) => person.displayName ?? person.email),
      canAct: item.canAct,
      conversationIds: item.conversationIds,
      subject: item.subject
        ? {
            id: item.subject.id,
            title: item.subject.title,
            url: item.subject.url,
          }
        : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      url: `${origin}/inbox?item=${enc(item.id)}`,
    };
  }

  function triggerText(automation) {
    if (automation.kind === "scheduled") {
      return `${automation.schedule} (${automation.timezone})`;
    }
    const { events, filters } = automation.trigger;
    return [`${events.join(", ")} on ${automation.resource}`, ...filters].join(
      "; ",
    );
  }

  function mcpAutomation(automation) {
    return {
      id: automation.id,
      kind: automation.kind,
      title: automation.title,
      task: automation.task,
      status: automation.status,
      statusReason: automation.statusReason || undefined,
      trigger: triggerText(automation),
      nextRunAt:
        automation.kind === "scheduled"
          ? automation.nextRunAt || undefined
          : undefined,
      destination: automation.destination.label,
      createdBy: automation.createdBy,
      ownedByYou: automation.ownedByViewer,
      lastRunAt: automation.lastRunAt || undefined,
      lastRunStatus: automation.lastRunStatus || undefined,
      lastConversationId: automation.lastConversationId || undefined,
      url: link("automations", automation.id),
    };
  }

  const tools = [
    {
      name: "searchConversations",
      scope: "conversations:read",
      title: "Search conversations",
      description:
        "Search your conversations and return up to 50, newest activity first. Only conversations that you started or take part in match.",
      annotations: READ_ONLY,
      input: {
        q: {
          type: "string",
          trim: true,
          max: 200,
          optional: true,
          description:
            "Text to search for in titles, summaries, and Annotation labels and titles.",
        },
        status: {
          enum: ["active", "archived"],
          default: "active",
          description:
            "Return conversations that are not archived (default) or that are archived. A search ignores this filter.",
        },
        includeThreads: {
          type: "boolean",
          optional: true,
          description:
            "True nests the Threads of each conversation under it in `threads`.",
        },
      },
      async run({ includeThreads, q, status }) {
        const query = new URLSearchParams({ status });
        if (q) query.set("q", q);
        const feed = await apiJson("GET", `/conversations?${query}`);
        const row = (item) => ({
          ...mcpConversation(item),
          ...(item.threads?.length
            ? { threads: item.threads.map(row) }
            : undefined),
        });
        return {
          conversations: feed.conversations.map(
            includeThreads ? row : mcpConversation,
          ),
        };
      },
    },
    {
      name: "getConversation",
      scope: "conversations:read",
      title: "Get conversation",
      description:
        "Get one conversation: its metadata, including its summary, the messages that no turn has read yet, and a `cursor`. Without `after`, it returns the last assistant reply. With `after`, it returns the messages after that point instead. To follow a conversation, call it again with the newest `cursor` until `turnActive` is false and `hasMore` is not set. Use listConversationMessages for older messages.",
      annotations: READ_ONLY,
      input: {
        conversationId,
        after: cursorParam(
          "`cursor` from sendMessage, createConversation, or an earlier getConversation call.",
        ),
      },
      async run({ after, conversationId: id }) {
        const afterSeq = after ? decodeCursor(id, after) : undefined;
        if (after && afterSeq === undefined) {
          throw new ToolError(
            "The cursor is not valid. Omit `after` to read the current state.",
          );
        }
        const detail = await requireDetail(id);
        const newer =
          afterSeq === undefined
            ? undefined
            : detail.eventHistory.status === "expired"
              ? { messages: [], hasMore: false, seq: afterSeq }
              : messagesAfter((await readTranscript(id)).events, afterSeq);
        const lastReply = newer
          ? undefined
          : mcpMessages(detail.events)
              .filter((message) => message.role === "assistant")
              .at(-1);
        return {
          conversation: mcpConversation(detail),
          lastReply,
          messages: newer?.messages,
          hasMore: newer?.hasMore ? true : undefined,
          ...(await readPendingWork(id)),
          cursor: encodeCursor(
            id,
            newer?.seq ?? detail.events.at(-1)?.seq ?? -1,
          ),
        };
      },
    },
    {
      name: "listConversationMessages",
      scope: "conversations:read",
      title: "List conversation messages",
      description:
        "List the user and assistant messages of one conversation, oldest first, ending with the newest. Tool calls are not included.",
      annotations: READ_ONLY,
      input: {
        conversationId,
        before: cursorParam(
          "`nextCursor` from an earlier call. Lists the messages before it.",
        ),
        limit: {
          type: "integer",
          min: 1,
          max: 50,
          default: 10,
          description: "Maximum number of messages.",
        },
      },
      async run({ before, conversationId: id, limit }) {
        const { detail, events } = await readTranscript(id);
        const beforeSeq = before ? decodeCursor(id, before) : undefined;
        if (before && beforeSeq === undefined) {
          throw new ToolError(
            "The cursor is not valid. Omit `before` to read the newest messages.",
          );
        }
        // An expired transcript stands in for a purged one.
        if (detail.eventHistory.status === "expired") return { messages: [] };
        const older =
          beforeSeq === undefined
            ? events
            : events.filter((event) => event.seq < beforeSeq);
        const page = older.slice(-EVENT_SCAN_LIMIT);
        const previousSeq =
          older.length > page.length ? page[0]?.seq : undefined;
        const scanned = mcpMessages(page);
        const messages = scanned.slice(-limit);
        const olderSeq =
          scanned.length > messages.length ? messages[0]?.seq : previousSeq;
        return {
          messages,
          nextCursor:
            olderSeq === undefined ? undefined : encodeCursor(id, olderSeq),
        };
      },
    },
    {
      name: "archiveConversation",
      scope: "conversations:manage",
      title: "Archive conversation",
      description:
        "Archive one of your conversations, or restore it, for everyone in it. Archiving a conversation hides it and its child conversations. A restore fails while a conversation above it is archived. A new message from a person restores the conversation and the archived conversations above it.",
      annotations: MANAGE,
      input: {
        conversationId,
        archived: {
          type: "boolean",
          default: true,
          description: "False restores an archived conversation.",
        },
        applyToChildren: {
          type: "boolean",
          default: false,
          description:
            "On archive, true also archives every child of this conversation at any depth; without it, the archive fails while any of its children is not archived. On restore, true also restores the children that were archived with this conversation.",
        },
        lastSeenAt: {
          type: "string",
          datetime: true,
          description:
            "`lastSeenAt` from searchConversations or getConversation. The archive fails when the conversation has newer activity.",
        },
      },
      async run({ applyToChildren, archived, conversationId: id, lastSeenAt }) {
        const detail = await requireDetail(id);
        // Like the API, an archive needs the newest activity time.
        if (
          archived &&
          Date.parse(detail.lastSeenAt) !== Date.parse(lastSeenAt)
        ) {
          throw new ToolError("Conversation received new activity.");
        }
        const result = await apiJson(
          "PATCH",
          `/conversations/${enc(id)}/archive`,
          {
            applyToChildren,
            archived,
            lastSeenAt,
          },
        );
        // The API also reads an archived conversation to the end.
        if (archived) {
          await apiJson("PUT", `/conversations/${enc(id)}/read-position`, {
            lastReadSeq: Number.MAX_SAFE_INTEGER,
          });
        }
        return { archivedAt: result.archivedAt };
      },
    },
    {
      name: "archiveDoneConversations",
      scope: "conversations:manage",
      title: "Archive done conversations",
      description:
        "Archive all of your conversations whose work is done and that stayed quiet for your auto-archive wait time, once. It skips conversations that anyone pinned or turned auto-archive off for, and conversations that wait on a person. Archive applies to everyone in the conversation.",
      annotations: MANAGE,
      input: {},
      async run() {
        const result = await apiJson("POST", "/conversations/archive-done");
        return { archived: result.archived };
      },
    },
    {
      name: "pinConversation",
      scope: "conversations:manage",
      title: "Pin conversation",
      description:
        "Pin one of your top-level conversations, or unpin it. A child conversation cannot be pinned or unpinned; it uses the pin of its root. A pin applies only to you, restores an archived conversation, and keeps auto-archive from archiving it.",
      annotations: MANAGE,
      input: {
        conversationId,
        pinned: {
          type: "boolean",
          default: true,
          description: "False unpins the conversation.",
        },
      },
      async run({ conversationId: id, pinned }) {
        const result = await apiJson("PATCH", `/conversations/${enc(id)}/pin`, {
          pinned,
        });
        return { pinnedAt: result.pinnedAt };
      },
    },
    {
      name: "renameConversation",
      scope: "conversations:manage",
      title: "Rename conversation",
      description:
        "Rename one of your conversations for everyone in it. Later turns keep the new title. The Slack thread does not change. Returns the stored title.",
      annotations: MANAGE,
      input: {
        conversationId,
        title: conversationTitle,
      },
      async run({ conversationId: id, title }) {
        const result = await apiJson(
          "PATCH",
          `/conversations/${enc(id)}/title`,
          { title },
        );
        return { title: result.title };
      },
    },
    {
      name: "setConversationAutoArchive",
      scope: "conversations:manage",
      title: "Set conversation auto-archive",
      description:
        "Turn auto-archive on or off for one of your conversations. This overrides your default for that conversation only.",
      annotations: MANAGE,
      input: {
        conversationId,
        autoArchive: {
          type: "boolean",
          description:
            "True lets auto-archive archive the conversation for everyone after its work is done. False keeps it from auto-archive for everyone.",
        },
      },
      async run({ autoArchive, conversationId: id }) {
        const result = await apiJson(
          "PATCH",
          `/conversations/${enc(id)}/auto-archive`,
          { autoArchive },
        );
        return { autoArchive: result.autoArchive };
      },
    },
    {
      name: "setConversationSubscription",
      scope: "conversations:manage",
      title: "Set conversation subscription",
      description:
        "Subscribe to one of your conversations, or unsubscribe from it. Unsubscribe removes it only from your feed and clears your pin. When nobody else is subscribed, it archives the conversation for everyone. Your next mention of the bot in it subscribes you again.",
      annotations: MANAGE,
      input: {
        conversationId,
        subscribed: { type: "boolean", description: "False unsubscribes you." },
      },
      async run({ conversationId: id, subscribed }) {
        const result = await apiJson(
          "PATCH",
          `/conversations/${enc(id)}/subscription`,
          { subscribed },
        );
        return { archivedAt: result.archivedAt, subscribed: result.subscribed };
      },
    },
    {
      name: "markConversationRead",
      scope: "conversations:manage",
      title: "Mark conversation read",
      description:
        "Mark one of your conversations as read for you. The read position only moves forward.",
      annotations: MANAGE,
      input: {
        conversationId,
        lastReadSeq: {
          type: "integer",
          min: 0,
          optional: true,
          description:
            "`seq` of the last message read, from listConversationMessages or getConversation. Omit it to mark every message read.",
        },
      },
      async run({ conversationId: id, lastReadSeq }) {
        const result = await apiJson(
          "PUT",
          `/conversations/${enc(id)}/read-position`,
          { lastReadSeq: lastReadSeq ?? Number.MAX_SAFE_INTEGER },
        );
        return { lastReadSeq: result.lastReadSeq };
      },
    },
    {
      name: "stopConversation",
      scope: "conversations:manage",
      title: "Stop conversation",
      description:
        "Stop one of your conversations: its running turn and every child agent below it. Until you send the conversation a message, watch events of it and its child agents are saved to the conversation but start no turn. Messages that wait for the turn are dropped. It starts no new work.",
      annotations: DESTRUCTIVE,
      input: { conversationId },
      async run({ conversationId: id }) {
        const detail = await requireDetail(id);
        // The mock has no turns to stop. `turnActive` stands for a running turn.
        const running = detail.turnActive && !stopped.has(id);
        const { pendingMessages } = await readPendingWork(id);
        stopped.add(id);
        if (running) droppedPending.add(id);
        return {
          conversationId: id,
          status: running ? "requested" : "no_work",
          stoppedInboundMessageIds: running
            ? pendingMessages.map((message) => message.messageId)
            : [],
          stoppedMessages: [],
        };
      },
    },
    {
      name: "cancelQueuedMessages",
      scope: "conversations:manage",
      title: "Cancel queued messages",
      description:
        "Drop every message that waits for the running turn of one of your conversations. The running turn continues.",
      annotations: DESTRUCTIVE,
      input: { conversationId },
      async run({ conversationId: id }) {
        await requireDetail(id);
        const { pendingMessages } = await readPendingWork(id);
        droppedPending.add(id);
        return {
          cancelledCount: pendingMessages.length,
          cancelledInboundMessageIds: pendingMessages.map(
            (message) => message.messageId,
          ),
          conversationId: id,
        };
      },
    },
    {
      name: "createConversation",
      scope: "conversations:write",
      title: "Create conversation",
      description:
        "Start a new conversation as you, with a first message. The agent works on it in the background. Returns the messages that no turn has read yet and a `cursor`. Pass the `cursor` as `after` to getConversation to read the reply.",
      annotations: SEND,
      input: {
        message: messageText,
        title: {
          ...conversationTitle,
          optional: true,
          description:
            "Short title for the conversation. Omit it to generate one from the message.",
        },
        visibility: {
          enum: ["private", "public"],
          default: "private",
          description:
            "`private` keeps it to its participants. `public` lets people in your workspace find and read it.",
        },
        idempotencyKey,
      },
      async run({ idempotencyKey: key, message, title, visibility }) {
        const accepted = await apiJson("POST", "/conversations", {
          idempotencyKey: key ?? randomUUID(),
          message,
          ...(title ? { title } : undefined),
          visibility,
        });
        const id = accepted.conversationId;
        // The dashboard mock titles every new conversation from its message.
        if (title && accepted.status === "accepted") {
          await apiJson("PATCH", `/conversations/${enc(id)}/title`, { title });
        }
        return {
          ...accepted,
          ...(await readPendingWork(id)),
          // A new Conversation has no events yet.
          cursor: encodeCursor(id, -1),
          url: link("conversations", id),
        };
      },
    },
    {
      name: "sendMessage",
      scope: "conversations:write",
      title: "Send message",
      description:
        "Send a message as you to one of your conversations. The agent answers in the background. When a turn is running, the message waits for it unless `delivery` is `interrupt`. Returns the messages that no turn has read yet and a `cursor`. Pass the `cursor` as `after` to getConversation to read the reply.",
      annotations: SEND,
      input: {
        conversationId,
        message: messageText,
        idempotencyKey,
        delivery: {
          enum: ["defer", "interrupt"],
          default: "defer",
          description:
            "`defer` waits for the running turn to end. `interrupt` joins the running turn at its next safe step. Use it to correct or add to the work in progress.",
        },
      },
      // Mock sends land in the transcript at once, so `delivery` changes
      // nothing that a client can see.
      async run({ conversationId: id, idempotencyKey: key, message }) {
        const before = await readTranscript(id);
        const lastSeq = before.events.at(-1)?.seq ?? -1;
        const accepted = await apiJson(
          "POST",
          `/conversations/${enc(id)}/messages`,
          { idempotencyKey: key ?? randomUUID(), message },
        );
        if (accepted.status === "accepted") stopped.delete(id);
        // A retry starts before the message, so the cursor keeps its reply.
        const messageSeq =
          accepted.status === "duplicate"
            ? (await readTranscript(id)).events.find(
                ({ data }) =>
                  data.type === "message" &&
                  data.messageId === accepted.messageId,
              )?.seq
            : undefined;
        return {
          ...accepted,
          ...(await readPendingWork(id)),
          cursor: encodeCursor(
            id,
            messageSeq === undefined ? lastSeq : messageSeq - 1,
          ),
          url: link("conversations", id),
        };
      },
    },
    {
      name: "searchInboxItems",
      scope: "inbox_items:read",
      title: "Search inbox items",
      description:
        "Search the open inbox items that you can see, newest change first. An inbox item is a question or notice that waits for a person.",
      annotations: READ_ONLY,
      input: {
        q: {
          type: "string",
          trim: true,
          min: 1,
          max: 200,
          optional: true,
          description: "Words to find in the title or body.",
        },
        conversationId: {
          type: "string",
          min: 1,
          optional: true,
          description: "Return only the items linked to this conversation.",
        },
        limit: {
          type: "integer",
          min: 1,
          max: 50,
          default: 20,
          description: "Maximum number of items.",
        },
      },
      async run({ conversationId: id, limit, q }) {
        const query = new URLSearchParams();
        if (id) query.set("conversationId", id);
        const list = await apiJson("GET", `/inbox-items?${query}`);
        const words = q?.toLowerCase();
        const notice =
          !id || REPLY_NOTICE.conversationIds.includes(id)
            ? [REPLY_NOTICE]
            : [];
        const items = [...list.items, ...notice]
          .filter(
            (item) =>
              item.status === "open" &&
              (!words ||
                `${item.title}\n${item.body}`.toLowerCase().includes(words)),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return {
          items: items.slice(0, limit).map(mcpInboxItem),
          truncated: items.length > limit,
        };
      },
    },
    {
      name: "getInboxItem",
      scope: "inbox_items:read",
      title: "Get inbox item",
      description: "Get one inbox item, open or closed.",
      annotations: READ_ONLY,
      input: {
        id: {
          type: "string",
          min: 1,
          description: "Inbox item id from searchInboxItems.",
        },
      },
      async run({ id }) {
        if (id === REPLY_NOTICE.id) return { item: mcpInboxItem(REPLY_NOTICE) };
        const result = await api("GET", `/inbox-items/${enc(id)}`);
        if (result.status === 404) {
          throw new ToolError("Inbox item not found.");
        }
        if (!result.ok) throw apiFailure(result);
        return { item: mcpInboxItem(result.json) };
      },
    },
    {
      name: "searchAutomations",
      scope: "automations:read",
      title: "Search automations",
      description:
        "Search the automations that you can see, newest first. An automation is a saved instruction or skill that runs on a schedule or on events.",
      annotations: READ_ONLY,
      input: {
        q: {
          type: "string",
          trim: true,
          max: 200,
          optional: true,
          description:
            "Text to search for in titles, instructions, and skill names.",
        },
        scope: {
          enum: ["all", "mine", "attention"],
          default: "all",
          description:
            "`mine` lists the ones you created. `attention` lists the ones that are blocked, cannot run, or had a problem in their last run.",
        },
        state: {
          enum: [
            "all",
            "active",
            "blocked",
            "paused",
            "completed",
            "unavailable",
          ],
          default: "all",
          description: "Filter by state.",
        },
        skill: {
          type: "string",
          max: 64,
          pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          patternMessage: "Use a skill name, such as tpm.",
          optional: true,
          description: "Only automations that run this skill, by exact name.",
        },
        page: {
          type: "integer",
          min: 1,
          max: 1_000_000,
          default: 1,
          description: "Page number, from 1.",
        },
      },
      async run({ page, q, scope, skill, state }) {
        const query = new URLSearchParams({ page: String(page), scope, state });
        if (q) query.set("q", q);
        if (skill) query.set("skill", skill);
        const list = await apiJson("GET", `/automations?${query}`);
        return {
          automations: list.automations.map(mcpAutomation),
          total: list.total,
        };
      },
    },
    {
      name: "getAutomation",
      scope: "automations:read",
      title: "Get automation",
      description: `Get one automation and its ${RECENT_RUN_LIMIT} newest runs.`,
      annotations: READ_ONLY,
      input: {
        id: {
          type: "string",
          min: 1,
          description: "Automation id from searchAutomations.",
        },
      },
      async run({ id }) {
        const [automation, list] = await Promise.all([
          api("GET", `/automations/${enc(id)}`),
          api("GET", `/automations/${enc(id)}/executions`),
        ]);
        for (const result of [automation, list]) {
          if (result.status === 404)
            throw new ToolError("Automation not found.");
          if (!result.ok) throw apiFailure(result);
        }
        return {
          automation: mcpAutomation(automation.json),
          runs: list.json.executions
            .slice(0, RECENT_RUN_LIMIT)
            .map(({ conversationId: runId, error, executedAt, status }) => ({
              executedAt,
              status,
              error: error || undefined,
              conversationId: runId || undefined,
            })),
        };
      },
    },
  ];

  function reset() {
    stopped.clear();
    droppedPending.clear();
  }

  return { reset, tools };
}
