/** Thrown when a tool fails due to invalid model/user input, not a system error. */
export class ToolInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolInputError";
  }
}
