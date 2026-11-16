import type * as z from "zod";

/**
 * Error map for a dispatcher envelope schema. It tells the model to nest the
 * target tool's fields under `arguments` when it sends them at the top level.
 */
export function nestedArgumentsErrorMap(label: string): z.core.$ZodErrorMap {
  return (issue) =>
    issue.code === "unrecognized_keys"
      ? `${label} arguments must be nested under arguments, not top-level fields: ${issue.keys.join(", ")}`
      : undefined;
}
