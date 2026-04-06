/** Normalize LLM tool params into the shape expected by the sandbox executor. */
export function buildSandboxInput(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "bash") {
    return { command: String(params.command ?? "") };
  }
  if (toolName === "readFile") {
    return { path: String(params.path ?? "") };
  }
  if (toolName === "writeFile") {
    return {
      path: String(params.path ?? ""),
      content: String(params.content ?? ""),
    };
  }
  return params;
}
