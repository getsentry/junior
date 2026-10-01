/**
 * OAuth callbacks save readiness, not agent history. The conversation worker
 * consumes this event under its lease before it resumes the paused Turn.
 */
import { z } from "zod";
import type { Destination } from "@sentry/junior-plugin-api";
import { getConversationEventStore } from "@/chat/db";
import { getTurnRecord, type TurnRecord } from "./checkpoint";

const authorizationSchema = z.object({
  kind: z.enum(["mcp", "plugin"]),
  provider: z.string().min(1),
  actorId: z.string().min(1),
  authorizationId: z.string().min(1),
  authSessionId: z.string().optional(),
  scope: z.string().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  toolChannelId: z.string().optional(),
});

function authorizationKey(
  turn: Pick<TurnRecord, "turnId" | "version">,
): string {
  return `turn:${turn.turnId}:authorization:${turn.version}`;
}

/** Save authorization for this parked boundary without changing model history. */
export async function recordTurnAuthorization(
  args: z.infer<typeof authorizationSchema> & {
    conversationId: string;
    destination: Destination;
    turnId: string;
  },
) {
  const turn = await getTurnRecord(args.conversationId, args.turnId);
  if (!turn || turn.state !== "paused" || turn.resumeReason !== "auth") return;
  await getConversationEventStore().append(
    args.conversationId,
    [
      {
        idempotencyKey: authorizationKey(turn),
        createdAtMs: Date.now(),
        data: {
          type: "structured_event",
          namespace: "junior",
          name: "turn_authorized",
          version: 1,
          turnId: turn.turnId,
          content: authorizationSchema.parse(args),
        },
      },
    ],
    { activity: "preserve" },
  );
  return {
    conversationId: args.conversationId,
    destination: args.destination,
    turnId: turn.turnId,
    expectedVersion: turn.version,
  };
}

/** Read authorization for the exact pause; a later auth pause needs its own callback. */
export async function getTurnAuthorization(turn: TurnRecord) {
  const event = await getConversationEventStore().loadByIdempotencyKey(
    turn.conversationId,
    authorizationKey(turn),
  );
  if (event?.data.type !== "structured_event") return undefined;
  return authorizationSchema.parse(event.data.content);
}
