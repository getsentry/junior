import type { PluginRuntimeDependency } from "@/chat/plugins/types";

// Verify additions by installing them in a stock Vercel node22 sandbox. Package
// availability differs from upstream Fedora, and entries install in this order.
export const GLOBAL_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
  { type: "system", package: "spal-release" },
  { type: "system", package: "ripgrep" },
];
