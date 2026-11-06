import type { AnyToolDefinition, ToolExposure } from "@/chat/tools/definition";

export interface PlannedToolExposure {
  /** Tools that `searchTools` finds and `executeTool` runs. */
  catalogTools: Record<string, AnyToolDefinition>;
  /** Tools that the model sees and calls directly. */
  directTools: Record<string, AnyToolDefinition>;
  /** Tools that a Code Mode script may call. */
  scriptTools: Record<string, AnyToolDefinition>;
}

/** Return the runtime exposure for a tool, preserving direct compatibility. */
export function effectiveToolExposure(
  definition: AnyToolDefinition,
): ToolExposure {
  return definition.exposure ?? "direct";
}

/** Plan which callers may call each tool. `ToolExposure` owns the rules. */
export function planToolExposure(
  tools: Record<string, AnyToolDefinition>,
): PlannedToolExposure {
  const directTools: Record<string, AnyToolDefinition> = {};
  const catalogTools: Record<string, AnyToolDefinition> = {};
  const scriptTools: Record<string, AnyToolDefinition> = {};

  for (const [name, definition] of Object.entries(tools)) {
    switch (effectiveToolExposure(definition)) {
      case "direct":
        directTools[name] = definition;
        catalogTools[name] = definition;
        scriptTools[name] = definition;
        break;
      case "deferred":
        catalogTools[name] = definition;
        scriptTools[name] = definition;
        break;
      case "modelOnly":
        directTools[name] = definition;
        break;
      case "codemode":
        scriptTools[name] = definition;
        break;
      case "hidden":
        break;
    }
  }

  return { catalogTools, directTools, scriptTools };
}
