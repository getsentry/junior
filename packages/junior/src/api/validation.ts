import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { throwApiError } from "./http";

/** Validate one request input and use Junior's stable JSON error contract. */
export function validateRequest<
  TTarget extends keyof ValidationTargets,
  TSchema extends z.ZodType,
>(target: TTarget, schema: TSchema, message: string) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throwApiError(400, message, result.error);
  });
}
