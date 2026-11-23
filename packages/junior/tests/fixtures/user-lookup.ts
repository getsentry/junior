import { getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { createUserLookupTool } from "@/chat/tools/user-lookup";

/** Run a tool's `execute` the way the agent runtime does. */
export async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared, {} as any);
}

/** Build `userLookup` for the test workspace with Slack and GitHub. */
export function lookupTool() {
  const teamId = parseSlackTeamId("T0TEST");
  if (!teamId) throw new Error("invalid test team id");
  return createUserLookupTool(teamId, ["slack", "github"], {
    fetch: async () => {
      throw new Error("userLookup tests make no provider requests");
    },
  });
}

/** Store a Slack person who linked a GitHub account. */
export async function seedLinkedIdentities(input: {
  githubId: string;
  githubHandle: string;
  slackUserId: string;
  slackHandle: string;
}) {
  const slackIdentity = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: "T0TEST",
    providerSubjectId: input.slackUserId,
    email: `${input.slackHandle}@sentry.io`,
    emailVerified: true,
    displayName: input.slackHandle,
    handle: input.slackHandle,
  });
  if (!slackIdentity.userId) throw new Error("missing linked user");
  await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
    kind: "user",
    provider: "github",
    providerSubjectId: input.githubId,
    handle: input.githubHandle,
  });
}
