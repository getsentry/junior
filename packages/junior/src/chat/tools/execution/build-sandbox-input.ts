/** Normalize LLM tool params into the shape expected by the sandbox executor. */
export function buildSandboxInput(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const optionalNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  if (toolName === "bash") {
    return {
      command: String(params.command ?? ""),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : undefined),
      ...(params.env &&
      typeof params.env === "object" &&
      !Array.isArray(params.env)
        ? { env: params.env }
        : undefined),
      ...(optionalNumber(params.timeoutMs)
        ? { timeoutMs: optionalNumber(params.timeoutMs) }
        : undefined),
    };
  }
  if (toolName === "readFile") {
    return {
      path: String(params.path ?? ""),
      ...(optionalNumber(params.offset)
        ? { offset: optionalNumber(params.offset) }
        : undefined),
      ...(optionalNumber(params.limit)
        ? { limit: optionalNumber(params.limit) }
        : undefined),
    };
  }
  if (toolName === "editFile") {
    return {
      path: String(params.path ?? ""),
      edits: Array.isArray(params.edits) ? params.edits : [],
    };
  }
  if (toolName === "grep") {
    return {
      pattern: String(params.pattern ?? ""),
      ...(typeof params.path === "string" ? { path: params.path } : undefined),
      ...(typeof params.glob === "string" ? { glob: params.glob } : undefined),
      ...(typeof params.ignoreCase === "boolean"
        ? { ignoreCase: params.ignoreCase }
        : undefined),
      ...(typeof params.literal === "boolean"
        ? { literal: params.literal }
        : undefined),
      ...(optionalNumber(params.context)
        ? { context: optionalNumber(params.context) }
        : undefined),
      ...(optionalNumber(params.limit)
        ? { limit: optionalNumber(params.limit) }
        : undefined),
    };
  }
  if (toolName === "findFiles") {
    return {
      pattern: String(params.pattern ?? ""),
      ...(typeof params.path === "string" ? { path: params.path } : undefined),
      ...(optionalNumber(params.limit)
        ? { limit: optionalNumber(params.limit) }
        : undefined),
    };
  }
  if (toolName === "listDir") {
    return {
      ...(typeof params.path === "string" ? { path: params.path } : undefined),
      ...(optionalNumber(params.limit)
        ? { limit: optionalNumber(params.limit) }
        : undefined),
    };
  }
  if (toolName === "writeFile") {
    return {
      path: String(params.path ?? ""),
      content: String(params.content ?? ""),
    };
  }
  return params;
}
