import { z } from "zod";

/** Whether this turn also publishes assistant output to the conversation location. */
export const publishExternallySchema = z.boolean();
