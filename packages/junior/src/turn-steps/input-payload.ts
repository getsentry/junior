// What the host writes in each inbox row of a core Turn. Core stores the
// payload and does not read it; the host reads it to build the prompt and
// the tools of each step.
import { actorSchema } from "@sentry/junior-plugin-api";
import * as z from "zod";

/** Parses the payload of an inbox row that the host wrote. */
export const turnInputPayloadSchema = z
  .object({ text: z.string().min(1), actor: actorSchema })
  .strict();

/** The payload of an inbox row that the host writes and reads. */
export type TurnInputPayload = z.output<typeof turnInputPayloadSchema>;
