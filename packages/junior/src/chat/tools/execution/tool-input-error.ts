import { PluginToolInputError } from "@sentry/junior-plugin-api";

/** Thrown when a tool fails due to invalid model/user input, not a system error. */
export class ToolInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolInputError";
  }
}

/** Whether an error is an expected tool input failure that is not a Sentry exception. */
export function isToolInputError(error: unknown): boolean {
  return (
    error instanceof ToolInputError ||
    error instanceof PluginToolInputError ||
    (error instanceof Error && error.name === "PluginToolInputError")
  );
}
