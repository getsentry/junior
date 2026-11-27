import * as z from "zod";
import {
  actionFromGuardian,
  guardianContext,
} from "@/chat/guardian/call-facts";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type { ActionDescription } from "@/chat/tool-support/definition";

/**
 * What Guardian gets for one MCP tool call. The provider plugin's
 * `guardian` hook answers first. Without an answer, a manifest that
 * declares `mcp.audience` makes the provider the target. Otherwise the call
 * has no target, and its audience counts as `world`.
 */
export async function mcpCallGuardian(args: {
  provider: string;
  /** The tool name that the agent calls, such as `mcp__linear__save_issue`. */
  toolName: string;
  input: unknown;
  conversationIds(): Promise<string[]>;
}): Promise<ActionDescription> {
  const prefix = `mcp__${args.provider}__`;
  const tool = args.toolName.startsWith(prefix)
    ? args.toolName.slice(prefix.length)
    : args.toolName;
  const parsed = z.record(z.string(), z.unknown()).safeParse(args.input);
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === args.provider,
  );
  const result = await plugin?.hooks?.guardian?.(
    { kind: "mcp", tool, input: parsed.success ? parsed.data : {} },
    guardianContext({
      plugin: args.provider,
      conversationIds: args.conversationIds,
    }),
  );
  if (result) {
    return actionFromGuardian(result);
  }
  const audience = pluginCatalogRuntime.getDefinition(args.provider)?.manifest
    .mcp?.audience;
  return audience ? { target: { ref: args.provider, audience } } : {};
}
