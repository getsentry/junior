import * as z from "zod";
import type { InboundMessage } from "./state";

const editMarkerSchema = z.looseObject({
  edit: z.object({ inboundMessageId: z.string().min(1).optional() }),
});

/**
 * Whether input edits earlier input. The marker on `interrupt` input lets a
 * running Turn steer the edit in. Alone, it starts no Turn.
 */
export function isInboundEdit(message: Pick<InboundMessage, "input">): boolean {
  return editMarkerSchema.safeParse(message.input.metadata).success;
}

/** Return the Inbound message that this edit changes, when it is known. */
export function editedInboundMessageId(
  message: Pick<InboundMessage, "input">,
): string | undefined {
  return editMarkerSchema.safeParse(message.input.metadata).data?.edit
    .inboundMessageId;
}

/** Return input metadata that marks an edit of earlier input. */
export function withEditMarker(
  metadata: Record<string, unknown> | undefined,
  inboundMessageId?: string,
): Record<string, unknown> {
  return { ...metadata, edit: inboundMessageId ? { inboundMessageId } : {} };
}
