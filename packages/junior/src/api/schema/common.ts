import { z } from "zod";

/** Stable error body returned by Junior-owned REST endpoints. */
export const apiErrorSchema = z.object({ error: z.string().min(1) }).strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
