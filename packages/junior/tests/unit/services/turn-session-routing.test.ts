import { describe, expect, it, vi } from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import {
  resolveConversationRouting,
  resolveTurnSessionRouting,
} from "@/chat/services/turn-session-routing";
import type { SessionSource } from "@/chat/source";
import type { Location } from "@/chat/conversations/location";

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
  conversationId?: string;
  destination?: Destination;
  parentConversationId?: string;
  location?: Location;
  sessionSource?: SessionSource;
}): Conversation {
  return {
    conversationId: args.conversationId ?? "slack:C123:1712345.0001",
    createdAtMs: 1,
    lastActivityAtMs: 1,
    updatedAtMs: 1,
    schemaVersion: 1,
    execution: { status: "paused" },
    ...(args.destination ? { destination: args.destination } : undefined),
    ...(args.parentConversationId
      ? { parentConversationId: args.parentConversationId }
      : undefined),
    ...(args.location ? { location: args.location } : undefined),
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
});

describe("resolveConversationRouting", () => {
  it("uses parent destination and session for children without destination", async () => {
    const store = conversationStore({
      get: vi.fn(async ({ conversationId }) => {
        if (conversationId === "agent:child") {
          return conversation({
            conversationId: "agent:child",
            parentConversationId: "slack:C123:1712345.0001",
          });
        }
        if (conversationId === "slack:C123:1712345.0001") {
          return conversation({
            destination: DESTINATION,
            location: {
              id: "location-123",
              provider: "slack",
              tenantId: "T123",
              providerId: "C123",
            },
            sessionSource: SOURCE,
          });
        }
        return undefined;
      }),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "agent:child",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: DESTINATION,
      location: {
        id: "location-123",
        provider: "slack",
        tenantId: "T123",
        providerId: "C123",
      },
      source: SOURCE,
    });
  });

  it("keeps a slack destination without inventing threadTs from the conversation id", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          destination: DESTINATION,
        }),
      ),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "slack:C123:1712345.0001",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: DESTINATION,
    });
  });

  it("keeps a stored slack session without inventing missing threadTs", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          conversationId: "opaque-root",
          destination: DESTINATION,
          sessionSource: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
            visibility: "public",
          },
        }),
      ),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "opaque-root",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: DESTINATION,
      source: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
      },
    });
  });

  it("returns local destination and stored session source as-is", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          conversationId: "local:web:abc",
          destination: {
            platform: "local",
            conversationId: "local:web:abc",
          },
          sessionSource: {
            platform: "local",
            visibility: "private",
            conversationId: "local:web:abc",
          },
        }),
      ),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "local:web:abc",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: {
        platform: "local",
        conversationId: "local:web:abc",
      },
      source: {
        platform: "local",
        visibility: "private",
        conversationId: "local:web:abc",
      },
    });
  });

  it("keeps a web session source on a local destination", async () => {
    const store = conversationStore({
      get: vi.fn(async () =>
        conversation({
          conversationId: "local:web:dashboard",
          destination: {
            platform: "local",
            conversationId: "local:web:dashboard",
          },
          sessionSource: {
            platform: "web",
            visibility: "public",
            conversationId: "local:web:dashboard",
          },
        }),
      ),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "local:web:dashboard",
        conversationStore: store,
      }),
    ).resolves.toEqual({
      destination: {
        platform: "local",
        conversationId: "local:web:dashboard",
      },
      source: {
        platform: "web",
        visibility: "public",
        conversationId: "local:web:dashboard",
      },
    });
  });

  it("returns undefined when no destination can be resolved", async () => {
    const store = conversationStore({
      get: vi.fn(async ({ conversationId }) => {
        if (conversationId === "agent:child") {
          return conversation({
            conversationId: "agent:child",
            parentConversationId: "agent-dispatch:task",
          });
        }
        if (conversationId === "agent-dispatch:task") {
          return conversation({ conversationId: "agent-dispatch:task" });
        }
        return undefined;
      }),
    });

    await expect(
      resolveConversationRouting({
        conversationId: "agent:child",
        conversationStore: store,
      }),
    ).resolves.toBeUndefined();
  });
});
