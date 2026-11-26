import { getChatConfig } from "@/chat/config";

/**
 * Resolve sandbox sizing. A Workspace vCPU setting wins over the app setting,
 * which wins over `SANDBOX_VCPUS`.
 */
export function getSandboxResources(workspace?: {
  vcpus: number | null;
}): { vcpus: number } | undefined {
  if (workspace?.vcpus) return { vcpus: workspace.vcpus };
  const { vcpus } = getChatConfig().sandbox;
  return vcpus === undefined ? undefined : { vcpus };
}
