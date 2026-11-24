import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import {
  canReadInboxItem,
  type InboxItemReader,
} from "@/chat/inbox-items/access";
import {
  getInboxItem,
  insertInboxItem,
  searchInboxItems,
  type InboxItemVisibility,
} from "@/chat/inbox-items/store";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { juniorAutomations, juniorIdentities } from "@/db/schema";

const T123 = { provider: "slack", providerTenantId: "T123" };
const T999 = { provider: "slack", providerTenantId: "T999" };
const PUBLIC_CONVERSATION = "slack:CPUB:1.000001";
const PRIVATE_CONVERSATION = "slack:CPRIV:1.000002";
const OTHER_CONVERSATION = "slack:COTHER:1.000003";

async function conversation(
  conversationId: string,
  visibility: InboxItemVisibility,
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: conversationId.split(":")[1]!,
    },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
}

async function userId(email: string): Promise<string> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  return user.id;
}

async function addItem(input: {
  assigneeUserIds: string[];
  automationId?: string;
  conversationId: string;
  key: string;
  visibility: InboxItemVisibility;
}): Promise<string> {
  // A run of an Automation adds its item from the run's own Conversation.
  let ownerId = input.conversationId;
  if (input.automationId) {
    ownerId = `slack:CRUN:${input.key}`;
    await conversation(ownerId, input.visibility);
    await recordAutomationExecution(input.automationId, {
      conversationId: ownerId,
      executionId: `run-${input.key}`,
    });
  }
  const item = await insertInboxItem(getDb(), {
    subject: { id: input.key, kind: "question" },
    owner: { id: ownerId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: input.assigneeUserIds,
    body: "Body",
    conversationIds: [input.conversationId],
    kind: "notice",
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    tenant: T123,
    title: input.key,
    visibility: input.visibility,
  });
  if (!item) throw new Error(`no item for ${input.key}`);
  return item.id;
}

describe("inbox item access", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("gives the same readers in search and in get", async () => {
    await conversation(PUBLIC_CONVERSATION, "public");
    await conversation(PRIVATE_CONVERSATION, "private");
    await conversation(OTHER_CONVERSATION, "public");
    const ana = await userId("ana@example.com");
    const carl = await userId("carl@example.com");
    await getDb()
      .insert(juniorIdentities)
      .values({
        createdAt: new Date(1),
        id: "identity:creator",
        kind: "user",
        provider: "slack",
        providerSubjectId: "UCREATOR",
        providerTenantId: "T123",
        updatedAt: new Date(1),
        userId: carl,
      });
    await getDb()
      .insert(juniorAutomations)
      .values({
        channelId: "CPUB",
        createdAtMs: 1,
        creatorIdentityId: "identity:creator",
        creatorSlackUserId: "UCREATOR",
        id: "auto-1",
        instruction: "Check entries.",
        kind: "scheduled",
        record: {} as any,
        status: "active",
        teamId: "T123",
      });
    const ids = {
      publicItem: await addItem({
        assigneeUserIds: [ana],
        automationId: "auto-1",
        conversationId: PUBLIC_CONVERSATION,
        key: "public",
        visibility: "public",
      }),
      privateItem: await addItem({
        assigneeUserIds: [ana],
        conversationId: PRIVATE_CONVERSATION,
        key: "private",
        visibility: "private",
      }),
      privateAutomationItem: await addItem({
        assigneeUserIds: [carl],
        automationId: "auto-1",
        conversationId: PRIVATE_CONVERSATION,
        key: "private-automation",
        visibility: "private",
      }),
    };
    type Name = keyof typeof ids;

    const cases: Array<[string, InboxItemReader, Name[]]> = [
      ["nobody", {}, []],
      ["same tenant", { tenants: [T123] }, ["publicItem"]],
      ["other tenant", { tenants: [T999] }, []],
      ["assigned User", { userId: ana }, ["privateItem", "publicItem"]],
      ["other assigned User", { userId: carl }, ["privateAutomationItem"]],
      [
        "public linked Conversation",
        { conversationId: PUBLIC_CONVERSATION },
        ["publicItem"],
      ],
      [
        "private linked Conversation",
        { conversationId: PRIVATE_CONVERSATION },
        ["privateAutomationItem", "privateItem"],
      ],
      [
        "agent in another Conversation of the tenant",
        { conversationId: OTHER_CONVERSATION, tenants: [T123] },
        ["publicItem"],
      ],
      [
        "Automation",
        { automationId: "auto-1" },
        ["privateAutomationItem", "publicItem"],
      ],
    ];

    const items = await Promise.all(
      Object.values(ids).map((id) => getInboxItem(getDb(), id)),
    );
    const actual: Record<string, { get: string[]; search: string[] }> = {};
    const wanted: Record<string, { get: string[]; search: string[] }> = {};
    for (const [label, reader, expected] of cases) {
      const expectedIds = expected.map((name) => ids[name]).sort();
      wanted[label] = { get: expectedIds, search: expectedIds };
      const searched = await searchInboxItems(getDb(), reader, {
        limit: 10,
        statuses: ["open", "done", "dismissed"],
      });
      actual[label] = {
        get: items
          .filter((item) => item && canReadInboxItem(item, reader))
          .map((item) => item!.id)
          .sort(),
        search: searched.map((item) => item.id).sort(),
      };
    }
    expect(actual).toEqual(wanted);
  });
});
