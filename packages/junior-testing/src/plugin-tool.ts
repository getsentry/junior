type PluginToolLike = {
  execute?: (input: never, options: never, ctx: never) => unknown;
};

type BoundExecute<TTool extends PluginToolLike> = (
  input: Parameters<NonNullable<TTool["execute"]>>[0],
  options: Parameters<NonNullable<TTool["execute"]>>[1],
) => ReturnType<NonNullable<TTool["execute"]>>;

/**
 * Give a plugin tool the Turn context that the host passes to `execute`, so a
 * test can call `execute(input, options)` like the host does in one Turn.
 */
export function bindPluginTool<TTool extends PluginToolLike>(
  tool: TTool | undefined,
  ctx: Parameters<NonNullable<TTool["execute"]>>[2],
): Omit<TTool, "execute"> & { execute: BoundExecute<TTool> } {
  const execute = tool?.execute;
  if (!tool || !execute) {
    throw new Error("Plugin tool has no execute");
  }
  return {
    ...tool,
    execute: (input, options) =>
      execute.call(tool, input, options, ctx as never) as ReturnType<
        NonNullable<TTool["execute"]>
      >,
  };
}

/** Bind every tool from a plugin `tools()` hook to one Turn context. */
export function bindPluginTools<TTool extends PluginToolLike>(
  tools: Record<string, TTool> | undefined,
  ctx: Parameters<NonNullable<TTool["execute"]>>[2],
): Record<string, ReturnType<typeof bindPluginTool<TTool>>> {
  return Object.fromEntries(
    Object.entries(tools ?? {}).map(([name, tool]) => [
      name,
      bindPluginTool(tool, ctx),
    ]),
  );
}
