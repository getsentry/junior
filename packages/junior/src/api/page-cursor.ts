import type * as z from "zod";
import { throwApiError } from "./http";

/**
 * Encode the position after the last row of a page as an opaque `cursor`
 * value. The cursor only moves a position inside a list that access already
 * scopes, so it carries no signature.
 */
export function encodePageCursor<Schema extends z.ZodType>(
  schema: Schema,
  position: z.input<Schema>,
): string {
  return Buffer.from(JSON.stringify(schema.parse(position)), "utf8").toString(
    "base64url",
  );
}

/** Decode a `cursor` query value with its schema, or answer 400. */
export function decodePageCursor<Schema extends z.ZodType>(
  schema: Schema,
  value: string,
  message: string,
): z.output<Schema> {
  try {
    return schema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch (error) {
    throwApiError(400, message, error);
  }
}
