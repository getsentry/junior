import { locationSchema } from "@sentry/junior-plugin-api";
import type { z } from "zod";

export { locationSchema };

/** Validated Location associated with a Conversation. */
export type Location = z.output<typeof locationSchema>;
