import type { NoObjectGeneratedError } from "ai";

/**
 * Output tokens added on top of the object size that a caller asks for.
 * Reasoning models spend output tokens before they write the object, and the
 * provider counts both against one `maxOutputTokens` limit. With Guardian's
 * 2,000-token assessment, this keeps the 8,000 limit its evals pass at.
 */
const STRUCTURED_OUTPUT_REASONING_TOKENS = 6_000;

/**
 * Output token limit for an object of `objectTokens`, with room for reasoning.
 * It never exceeds the model's own output limit, which providers enforce.
 */
export function structuredOutputTokenLimit(
  objectTokens: number | undefined,
  modelMaxTokens: number | undefined,
): number | undefined {
  if (objectTokens === undefined) return undefined;
  const limit = objectTokens + STRUCTURED_OUTPUT_REASONING_TOKENS;
  return modelMaxTokens !== undefined ? Math.min(limit, modelMaxTokens) : limit;
}

/**
 * Keep only the fixed message and stack of a failed structured output. The SDK
 * error's `text` and its parse or validation cause hold the raw model output.
 * A `length` finish gets its own error, so a spent budget is not reported as a
 * malformed object.
 */
export function structuredOutputErrorCause(
  error: NoObjectGeneratedError,
): Error {
  const spentBudget = error.finishReason === "length";
  const cause = new Error(
    spentBudget
      ? "Structured output hit the output token limit"
      : error.message,
  );
  cause.name = spentBudget ? "StructuredOutputLengthError" : error.name;
  cause.stack = error.stack;
  return cause;
}
