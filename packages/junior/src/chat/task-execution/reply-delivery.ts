import { destinationSchema, type Destination } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { sameDestination } from "@/chat/destination";

/** Durable instruction for whether a turn may publish a provider reply. */
export const replyDeliverySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("destination"),
      destination: destinationSchema,
    })
    .strict(),
  z.object({ type: z.literal("conversation") }).strict(),
]);

/** Provider reply behavior persisted with inbound conversation work. */
export type ReplyDelivery = z.output<typeof replyDeliverySchema>;

/** Build provider reply delivery for an existing destination. */
export function deliverReplyTo(destination: Destination): ReplyDelivery {
  return { type: "destination", destination };
}

/** Compare two reply-delivery instructions without object identity. */
export function sameReplyDelivery(
  left: ReplyDelivery,
  right: ReplyDelivery,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "conversation" && right.type === "conversation") {
    return true;
  }
  return (
    left.type === "destination" &&
    right.type === "destination" &&
    sameDestination(left.destination, right.destination)
  );
}

/** Require provider reply delivery at a provider-owned runtime boundary. */
export function requireReplyDestination(
  replyDelivery: ReplyDelivery,
  action: string,
): Destination {
  if (replyDelivery.type === "destination") {
    return replyDelivery.destination;
  }
  throw new Error(`${action} requires provider reply delivery`);
}
