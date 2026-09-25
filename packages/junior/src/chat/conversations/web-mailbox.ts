import { z } from "zod";

// TODO(dcramer): Delete this legacy schema after every deployed mailbox record
// stores complete web Source and Actor values.
/** Parse web mailbox metadata written before Source and Actor were complete. */
export const legacyWebMailboxMetadataSchema = z
  .object({
    authorEmail: z.string().email(),
    authorFullName: z.string().min(1).optional(),
    authorUserId: z.string().min(1),
    authorUserName: z.string().min(1).optional(),
    kind: z.literal("api_turn"),
    messageId: z.string().min(1),
  })
  .strict();

/** Stored metadata used while web mailbox input has no complete Source. */
export type LegacyWebMailboxMetadata = z.output<
  typeof legacyWebMailboxMetadataSchema
>;
