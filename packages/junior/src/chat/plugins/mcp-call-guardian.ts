import * as z from "zod";
import {
  actionFromGuardian,
  guardianContext,
} from "@/chat/guardian/call-facts";
import { getAppContext } from "@/app/context";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import type { ActionDescription } from "@/chat/tool-support/definition";

/**
 * What Guardian gets for one MCP tool call. The provider plugin's
 * `guardian.tools` entry for the exact remote tool answers first. Without
 * one, a manifest that declares `mcp.guardian.audience` makes the provider
 * the target. Otherwise the call has no target, and its audience counts as
 * `world`.
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
  const guardian = getPlugins().find(
    (candidate) => candidate.manifest.name === args.provider,
  )?.hooks?.guardian?.tools?.[tool];
  if (guardian) {
    return actionFromGuardian(
      await guardian(
        parsed.success ? parsed.data : {},
        guardianContext({
          plugin: args.provider,
          conversationIds: args.conversationIds,
        }),
      ),
    );
  }
  const audience = getAppContext().catalog.getDefinition(args.provider)
    ?.manifest.mcp?.guardian?.audience;
  return audience ? { target: { ref: args.provider, audience } } : {};
}
