import { describe, expect, it, vi } from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import { resolveTurnSessionRouting } from "@/chat/services/turn-session-routing";
import type { SessionSource } from "@/chat/source";

const DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;

const SOURCE = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
  threadTs: "1712345.0001",
  visibility: "private",
} as const satisfies SessionSource;

function conversation(args: {
  destination?: Destination;
  sessionSource?: SessionSource;
}): Conversation {
  return {
    conversationId: "slack:C123:1712345.0001",
    createdAtMs: 1,
    lastActivityAtMs: 1,
    updatedAtMs: 1,
    schemaVersion: 1,
    execution: { status: "paused" },
    ...(args.destination ? { destination: args.destination } : undefined),
    ...(args.sessionSource ? { sessionSource: args.sessionSource } : undefined),
  };
}

function conversationStore(
  overrides: Partial<ConversationStore> = {},
): ConversationStore {
  return {
    createChild: vi.fn(),
    get: vi.fn(async () => undefined),
    getConversationIdByProviderConversation: vi.fn(async () => undefined),
    bindProviderConversation: vi.fn(),
    getDestinationVisibility: vi.fn(async () => undefined),
    findSlackDestinationByName: vi.fn(async () => undefined),
    recordActivity: vi.fn(),
    recordExecution: vi.fn(),
    listByActivity: vi.fn(),
    ...overrides,
  };
}

describe("resolveTurnSessionRouting", () => {
  it("loads destination and session source from sql", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          destination: DESTINATION,
          sessionSource: SOURCE,
        }),
      ),
    });

    await expect(
      resolveTurnSessionRouting({
        conversationId: "slack:C123:1712345.0001",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: DESTINATION,
      source: SOURCE,
    });
    expect(store.get).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
    });
  });

  it("rejects a conversation without durable routing metadata", async () => {
    const store = conversationStore({
      get: vi.fn(async () => conversation({})),
    });

    await expect(
      resolveTurnSessionRouting({
        conversationId: "slack:C123:1712345.0001",
        conversationStore: store,
      }),
    ).rejects.toThrow(
      "Conversation slack:C123:1712345.0001 is missing durable routing metadata",
    );
  });

  it("rejects destination-only legacy routing", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          destination: DESTINATION,
        }),
      ),
    });

    await expect(
      resolveTurnSessionRouting({
        conversationId: "agent-dispatch:dispatch-1",
        conversationStore: store,
      }),
    ).rejects.toThrow(
      "Conversation agent-dispatch:dispatch-1 is missing durable routing metadata",
    );
  });
});
