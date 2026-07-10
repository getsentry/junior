import { randomUUID } from "node:crypto";

const PRIVATE_TRACE_RESULT_ATTRIBUTE = "app.ai.tool.call.result.exposure";
const privateTraceResultToken = randomUUID();

/** Mark one tool result as an adapter-approved private trace projection. */
export function privateTraceResultAttributes(): Record<string, string> {
  return { [PRIVATE_TRACE_RESULT_ATTRIBUTE]: privateTraceResultToken };
}

/** Consume and remove the adapter-owned private trace projection marker. */
export function consumePrivateTraceResultMarker(
  attributes: Record<string, unknown>,
): boolean {
  const projected =
    attributes[PRIVATE_TRACE_RESULT_ATTRIBUTE] === privateTraceResultToken;
  delete attributes[PRIVATE_TRACE_RESULT_ATTRIBUTE];
  return projected;
}
