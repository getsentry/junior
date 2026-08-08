import { describe, expect, it } from "vitest";
import {
  agentsInstructionsUpdatedEvent,
  authenticationLinkedEvent,
  authenticationUnlinkedEvent,
  renderJuniorNativeConversationEvent,
} from "@/chat/conversations/structured-events";
import {
  conversationEventSchema,
  type ConversationEventData,
} from "@/chat/conversations/history";

describe("junior native authentication events", () => {
  it("renders linked and unlinked presentation safely", () => {
    expect(
      authenticationLinkedEvent.renderEvent({
        actorId: "U123",
        provider: "github",
        providerLabel: "GitHub",
        accountLabel: "dcramer",
      }),
    ).toEqual({
      icon: "link",
      title: "GitHub connected",
      preview: "Connected as `dcramer`",
      details: [
        {
          title: "GitHub connected",
          description: "Connected as `dcramer`",
          metadata: ["github"],
        },
      ],
    });

    expect(
      authenticationUnlinkedEvent.renderEvent({
        actorId: "U123",
        provider: "linear",
        providerLabel: "Linear",
      }),
    ).toEqual({
      icon: "key",
      title: "Linear disconnected",
      details: [
        {
          title: "Linear disconnected",
          metadata: ["linear"],
        },
      ],
    });
  });

  it("accepts native authentication events in the durable event schema", () => {
    const data: ConversationEventData = {
      type: "structured_event",
      namespace: "junior",
      name: "authentication_linked",
      version: 1,
      turnId: "turn-1",
      content: {
        actorId: "U123",
        provider: "github",
        providerLabel: "GitHub",
        accountLabel: "dcramer",
        authorizationId: "turn-1:plugin:github",
      },
    };

    expect(
      conversationEventSchema.parse({
        schemaVersion: 1,
        seq: 1,
        historyVersion: 0,
        idempotencyKey: "native-auth-linked-1",
        createdAtMs: 1_000,
        data,
      }).data,
    ).toEqual(data);

    expect(
      renderJuniorNativeConversationEvent({
        namespace: "junior",
        name: "authentication_linked",
        version: 1,
        content: data.content,
      }),
    ).toEqual({
      icon: "link",
      title: "GitHub connected",
      preview: "Connected as `dcramer`",
      details: [
        {
          title: "GitHub connected",
          description: "Connected as `dcramer`",
          metadata: ["github"],
        },
      ],
    });
  });

  it("skips unknown native event names", () => {
    expect(
      renderJuniorNativeConversationEvent({
        namespace: "junior",
        name: "not_a_real_event",
        version: 1,
        content: {},
      }),
    ).toBeUndefined();
  });

  it("renders AGENTS.md load presentation without the instruction body", () => {
    expect(
      agentsInstructionsUpdatedEvent.renderEvent({
        action: "loaded",
        directory: "/vercel/sandbox/junior",
        fingerprint: "abc123",
        sources: [{ path: "/vercel/sandbox/junior/AGENTS.md" }],
        textBytes: 2048,
      }),
    ).toEqual({
      icon: "brain",
      title: "Loaded AGENTS.md",
      preview: "`/vercel/sandbox/junior`",
      details: [
        {
          title: "Loaded AGENTS.md",
          description:
            "Directory: `/vercel/sandbox/junior` · Sources: `/vercel/sandbox/junior/AGENTS.md` · 2048 bytes",
          metadata: ["loaded", "/vercel/sandbox/junior/AGENTS.md"],
        },
      ],
    });

    const data: ConversationEventData = {
      type: "structured_event",
      namespace: "junior",
      name: "agents_instructions_updated",
      version: 1,
      turnId: "turn-1",
      content: {
        action: "loaded",
        directory: "/vercel/sandbox/junior",
        fingerprint: "abc123",
        sources: [{ path: "/vercel/sandbox/junior/AGENTS.md" }],
        textBytes: 2048,
      },
    };

    expect(
      conversationEventSchema.parse({
        schemaVersion: 1,
        seq: 2,
        historyVersion: 0,
        idempotencyKey: "native-agents-1",
        createdAtMs: 2_000,
        data,
      }).data,
    ).toEqual(data);
  });
});
