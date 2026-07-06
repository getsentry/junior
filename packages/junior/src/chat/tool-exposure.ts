import type { AnyToolDefinition, ToolExposure } from "@/chat/tools/definition";

export interface PlannedToolExposure {
  deferredTools: Record<string, AnyToolDefinition>;
  directTools: Record<string, AnyToolDefinition>;
  excludedTools: Record<string, AnyToolDefinition>;
}

/** Return the runtime exposure for a tool, preserving direct compatibility. */
export function effectiveToolExposure(
  definition: AnyToolDefinition,
): ToolExposure {
  return definition.exposure ?? "direct";
}

/** Plan which tools are native-visible, deferred through search, or withheld. */
export function planToolExposure(
  tools: Record<string, AnyToolDefinition>,
): PlannedToolExposure {
  const directTools: Record<string, AnyToolDefinition> = {};
  const deferredTools: Record<string, AnyToolDefinition> = {};
  const excludedTools: Record<string, AnyToolDefinition> = {};

  for (const [name, definition] of Object.entries(tools)) {
    switch (effectiveToolExposure(definition)) {
      case "direct":
        directTools[name] = definition;
        break;
      case "deferred":
        deferredTools[name] = definition;
        break;
      case "modelOnly":
      case "hidden":
        excludedTools[name] = definition;
        break;
    }
  }

  return { directTools, deferredTools, excludedTools };
}
