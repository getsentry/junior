import type { Adapter, WebhookOptions } from "chat";
import { describe, expect, it, vi } from "vitest";
import { JuniorChat } from "@/chat/ingress/junior-chat";

function createWebhookOptions() {
  const tasks: Promise<unknown>[] = [];
  const options: WebhookOptions = {
    waitUntil(task) {
      tasks.push(task);
    },
  };

  return { options, tasks };
}

describe("JuniorChat ingress overrides", () => {
  it("forwards webhook options to action handling", async () => {
    const handleActionEvent = vi.fn(async () => {});
    const runtime = {
      handleActionEvent,
      logger: { error: vi.fn() },
    } as unknown as JuniorChat;
    const { options, tasks } = createWebhookOptions();
    const event = {
      actionId: "approve",
      adapter: { name: "slack" } as Adapter,
      messageId: "m-action",
    } as Parameters<JuniorChat["processAction"]>[0];

    const task = JuniorChat.prototype.processAction.call(
      runtime,
      event,
      options,
    );

    expect(handleActionEvent).toHaveBeenCalledWith(event, options);
    expect(tasks).toHaveLength(1);
    await expect(task).resolves.toBeUndefined();
    await expect(tasks[0]).resolves.toBeUndefined();
  });

  it("forwards webhook options to slash command handling", async () => {
    const handleSlashCommandEvent = vi.fn(async () => {});
    const runtime = {
      handleSlashCommandEvent,
      logger: { error: vi.fn() },
    } as unknown as JuniorChat;
    const { options, tasks } = createWebhookOptions();
    const event = {
      adapter: { name: "slack" } as Adapter,
      channelId: "C123",
      command: "/junior",
      text: "help",
    } as Parameters<JuniorChat["processSlashCommand"]>[0];

    JuniorChat.prototype.processSlashCommand.call(runtime, event, options);

    expect(handleSlashCommandEvent).toHaveBeenCalledWith(event, options);
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]).resolves.toBeUndefined();
  });
});
