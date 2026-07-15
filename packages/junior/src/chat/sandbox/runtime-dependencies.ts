import type { PluginRuntimeDependency } from "@/chat/plugins/types";

export const GLOBAL_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
];
