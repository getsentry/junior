import type { AnyToolDefinition, ToolExposure } from "@/chat/tools/definition";

export interface PlannedToolExposure {
  deferredTools: Record<string, AnyToolDefinition>;
  directTools: Record<string, AnyToolDefinition>;
}

/** Return the runtime exposure for a tool, preserving direct compatibility. */
export function effectiveToolExposure(
  definition: AnyToolDefinition,
): ToolExposure {
  return definition.exposure ?? "direct";
}

/** Split complete tool definitions into native-visible and deferred groups. */
export function planToolExposure(
  tools: Record<string, AnyToolDefinition>,
): PlannedToolExposure {
  const directTools: Record<string, AnyToolDefinition> = {};
  const deferredTools: Record<string, AnyToolDefinition> = {};

  for (const [name, definition] of Object.entries(tools)) {
    switch (effectiveToolExposure(definition)) {
      case "direct":
        directTools[name] = definition;
        break;
      case "deferred":
        deferredTools[name] = definition;
        break;
      case "modelOnly":
        break;
      case "hidden":
        break;
    }
  }

  return { directTools, deferredTools };
}
