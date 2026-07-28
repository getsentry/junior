import { withSpan } from "@/chat/logging";

/** Record one stage of dependency snapshot resolution or creation. */
export async function trace<T>(
  name: string,
  op: string,
  attributes: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  return await withSpan(name, op, {}, callback, attributes);
}
