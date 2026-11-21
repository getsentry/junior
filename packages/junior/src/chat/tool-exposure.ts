import type {
  AnyToolDefinition,
  ToolExposure,
} from "@/chat/tool-support/definition";

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

// The table in the `ToolExposure` JSDoc, as data.
const EXPOSURE_TABLES = {
  direct: ["directTools", "catalogTools", "scriptTools"],
  deferred: ["catalogTools", "scriptTools"],
  modelOnly: ["directTools"],
  codemode: ["scriptTools"],
  hidden: [],
} satisfies Record<ToolExposure, (keyof PlannedToolExposure)[]>;

/** Plan which callers may call each tool. `ToolExposure` owns the rules. */
export function planToolExposure(
  tools: Record<string, AnyToolDefinition>,
): PlannedToolExposure {
  const planned: PlannedToolExposure = {
    catalogTools: {},
    directTools: {},
    scriptTools: {},
  };

  for (const [name, definition] of Object.entries(tools)) {
    for (const table of EXPOSURE_TABLES[effectiveToolExposure(definition)]) {
      planned[table][name] = definition;
    }
  }

  return planned;
}
