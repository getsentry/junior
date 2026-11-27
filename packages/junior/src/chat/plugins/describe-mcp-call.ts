import * as z from "zod";
import type { Target } from "@/chat/guardian/guardian";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { targetSchema } from "@/chat/plugins/describe-url";
import { getPlugins } from "@/chat/plugins/hooks/registry";

/**
 * The target of one MCP tool call, for Guardian. The provider plugin's
 * `describeMcpCall` hook answers first. Without an answer, a manifest that
 * declares `mcp.audience` makes the provider the target. Otherwise the call
 * has no target, and its audience counts as `world`.
 */
export async function describeMcpCall(args: {
  provider: string;
  /** The tool name that the agent calls, such as `mcp__linear__save_issue`. */
  toolName: string;
  input: unknown;
}): Promise<Target | undefined> {
  const prefix = `mcp__${args.provider}__`;
  const tool = args.toolName.startsWith(prefix)
    ? args.toolName.slice(prefix.length)
    : args.toolName;
  const parsed = z.record(z.string(), z.unknown()).safeParse(args.input);
  const input = parsed.success ? parsed.data : {};
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === args.provider,
  );
  const described = await plugin?.hooks?.describeMcpCall?.({ tool, input });
  if (described) {
    return targetSchema.parse(described);
  }
  const audience = pluginCatalogRuntime.getDefinition(args.provider)?.manifest
    .mcp?.audience;
  return audience ? { ref: args.provider, audience } : undefined;
}
