import { z } from "zod";

/** Accept the opaque project identifier returned by Vercel. */
export const vercelProjectIdSchema = z.string().trim().min(1);
