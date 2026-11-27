import { describe, expect, it } from "vitest";
import type { AutomationToolContext } from "@/chat/automations/tool-access";
import { createAutomationTool } from "@/chat/automations/tools/create";
import { createUpdateAutomationTool } from "@/chat/automations/tools/update";
import { createSlackCanvasCreateTool } from "@/chat/slack/tools/canvas/create";
import type { EventCatalog } from "@/chat/events/catalog";
import { conversationsInfoOk } from "../fixtures/slack/factories/api";
import { queueSlackApiResponse } from "../msw/handlers/slack-api";

const NO_EVENTS: EventCatalog = {};

const context: AutomationToolContext = {
  conversationId: "slack:TDELIVERY:CHOME",
  destination: { platform: "slack", teamId: "TDELIVERY", channelId: "CHOME" },
  users: { resolveActor: async () => undefined },
};

/** Slack's answer for a channel that another organization shares. */
function queueSharedChannel(channelId: string, name: string) {
  const body = conversationsInfoOk({ channelId, name, isMember: true });
  queueSlackApiResponse("conversations.info", {
    body: { ...body, channel: { ...body.channel, is_ext_shared: true } },
  });
}

describe("Slack channel targets", () => {
  it("counts a move to a Slack Connect channel as world", async () => {
    queueSharedChannel("CEXT", "acme-shared");
    const tool = createUpdateAutomationTool(context, NO_EVENTS);

    await expect(
      tool.guardian?.({
        automation_id: "a1",
        destination: "<#CEXT|acme-shared>",
      } as never),
    ).resolves.toEqual({
      target: { ref: "Slack channel #acme-shared", audience: "world" },
    });
  });

  it("gives an update that keeps the destination no facts", async () => {
    const tool = createUpdateAutomationTool(context, NO_EVENTS);

    await expect(
      tool.guardian?.({ automation_id: "a1", title: "Weekly" } as never),
    ).resolves.toBeUndefined();
  });

  it("checks this Conversation's own channel the same way", async () => {
    queueSharedChannel("CHOME", "partner-room");
    const tool = createAutomationTool(context, NO_EVENTS);

    const described = await tool.guardian?.({
      title: "Weekly figures",
      instruction: "Post the weekly figures.",
    } as never);

    expect(described?.target).toEqual({
      ref: "Slack channel #partner-room",
      audience: "world",
    });
  });

  it("counts a canvas in a Slack Connect channel as world", async () => {
    queueSharedChannel("CHOME", "partner-room");
    const tool = createSlackCanvasCreateTool(
      { destinationChannelId: "CHOME" } as never,
      { getOperationResult: () => undefined, setOperationResult: () => {} },
    );

    await expect(
      tool.guardian?.({ title: "Plan", markdown: "x" }),
    ).resolves.toEqual({
      target: { ref: "Slack channel #partner-room", audience: "world" },
    });
  });
});
