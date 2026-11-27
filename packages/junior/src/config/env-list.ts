// Parsing for env vars that hold a list.
import * as z from "zod";

/** Parse a list env var value: a JSON string array or comma-separated values. */
export function parseEnvList(
  name: string,
  rawValue: string | undefined,
): string[] | undefined {
  const value = rawValue?.trim();
  if (!value) return undefined;
  if (!value.startsWith("[")) return value.split(",");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array`, { cause: error });
  }
  const list = z.array(z.string()).safeParse(parsed);
  if (!list.success) throw new Error(`${name} must be a JSON string array`);
  return list.data;
}
