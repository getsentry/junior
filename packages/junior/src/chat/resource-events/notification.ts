import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { createSlackResourceEventInboundMessage } from "@/chat/task-execution/slack-work";
import type { ResourceEventSubscription } from "@/chat/resource-events/store";

export interface ResourceEventNotification {
  eventKey: string;
  eventType: string;
  occurredAtMs: number;
  provider: string;
  resourceRef: string;
  terminal?: boolean;
  trustedSummary: string;
  untrustedText?: string;
}

function eventText(
  subscription: ResourceEventSubscription,
  event: ResourceEventNotification,
): string {
  const lines = [
    "[event notification]",
    "",
    "A subscribed resource changed.",
    "",
    "Subscription:",
    `- resource: ${subscription.label}`,
    `- event: ${event.eventType}`,
    `- intent: ${subscription.intent}`,
    "",
    "Trusted event summary:",
    event.trustedSummary,
  ];
  if (event.untrustedText?.trim()) {
    lines.push("", "Untrusted provider content:", event.untrustedText.trim());
  }
  return lines.join("\n");
}

/** Enqueue a resource event as normal conversation mailbox input. */
export async function enqueueResourceEventNotification(args: {
  event: ResourceEventNotification;
  queue: ConversationWorkQueue;
  subscription: ResourceEventSubscription;
  state?: Parameters<typeof appendAndEnqueueInboundMessage>[0]["state"];
}): Promise<Awaited<ReturnType<typeof appendAndEnqueueInboundMessage>>> {
  if (args.subscription.destination.platform !== "slack") {
    throw new Error(
      "Resource event delivery currently requires a Slack destination",
    );
  }
  const subscription = {
    conversationId: args.subscription.conversationId,
    destination: args.subscription.destination,
    id: args.subscription.id,
  };
  return await appendAndEnqueueInboundMessage({
    message: createSlackResourceEventInboundMessage({
      event: args.event,
      subscription,
      text: eventText(args.subscription, args.event),
    }),
    queue: args.queue,
    state: args.state,
  });
}
