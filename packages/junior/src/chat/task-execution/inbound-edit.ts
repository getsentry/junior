import * as z from "zod";
import type { InboundMessage } from "./state";

const editMarkerSchema = z.looseObject({
  edit: z.object({ inboundMessageId: z.string().min(1) }),
});

/**
 * Return the Inbound message that this one edits. The marker on `interrupt`
 * input lets a running Turn steer the edit in. Alone, it starts no Turn.
 */
export function editedInboundMessageId(
  message: Pick<InboundMessage, "input">,
): string | undefined {
  return editMarkerSchema.safeParse(message.input.metadata).data?.edit
    .inboundMessageId;
}

/** Return input metadata that marks an edit of another Inbound message. */
export function withEditMarker(
  metadata: Record<string, unknown> | undefined,
  inboundMessageId: string,
): Record<string, unknown> {
  return { ...metadata, edit: { inboundMessageId } };
}
