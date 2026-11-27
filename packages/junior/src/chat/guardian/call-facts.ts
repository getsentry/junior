import type { GuardianContext } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { credentialContextForActor } from "@/chat/credentials/context";
import { createPluginEgress } from "@/chat/egress/plugin";
import { createPluginCache } from "@/chat/plugins/cache";
import type { ActionDescription } from "@/chat/tool-support/definition";

// Facts about a target, such as a repository's visibility, do not depend on
// who asked, so they are read as Junior's own system account.
const GUARDIAN_FACTS_ACTOR = { platform: "system", name: "guardian" } as const;

/**
 * What one plugin may read while Guardian reviews a call: its cache,
 * provider reads as Junior's system account, and its code changes. A read
 * never asks anyone to authorize.
 */
export function guardianContext(args: {
  plugin: string;
  /** The Conversations of the work that makes the call. */
  conversationIds(): Promise<string[]>;
}): GuardianContext {
  const codeChanges = createPluginCodeChanges(args.plugin);
  return {
    cache: createPluginCache(args.plugin),
    egress: createPluginEgress({
      credentialContext: credentialContextForActor(GUARDIAN_FACTS_ACTOR),
      pluginAuth: { async handleAuthRequired() {} },
    }),
    codeChanges: { list: async (filter) => await codeChanges.list(filter) },
    conversationIds: args.conversationIds,
  };
}

/** What a plugin's `guardian` returns, checked at the plugin boundary. */
const guardianResultSchema = z.object({
  target: z.string().min(1),
  audience: z.enum(["internal", "world"]),
  decision: z.enum(["allow", "ask", "deny"]).optional(),
  reason: z.string().min(1).optional(),
});

/** The action that Guardian reviews, from what a plugin says about a call. */
export function actionFromGuardian(result: unknown): ActionDescription {
  const { target, audience, decision, reason } =
    guardianResultSchema.parse(result);
  return {
    target: { ref: target, audience },
    ...(decision
      ? { toolDecision: { decision, ...(reason ? { reason } : undefined) } }
      : undefined),
  };
}
