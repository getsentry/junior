/**
 * Own MCP OAuth grants: authorization codes, access tokens, and refresh
 * tokens. Every secret is random, opaque, and stored only as a SHA-256 hash
 * in shared state with a TTL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { userSchema, type User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { MCP_SCOPE } from "./metadata";
import { mcpStateKey, stateKeyHash, type McpState } from "./state";

const CODE_TTL_MS = 60 * 1000;

const authorizationCodeSchema = z
  .object({
    clientId: z.string().min(1),
    codeChallenge: z.string().min(1),
    /** Grant that this code creates. Reuse of the code revokes it. */
    grantId: z.string().uuid(),
    redirectUri: z.string().min(1),
    resource: z.string().min(1),
    scope: z.literal(MCP_SCOPE),
    user: userSchema,
  })
  .strict();

function codeKey(code: string): string {
  return mcpStateKey("code", stateKeyHash(code));
}

/** Issue a single-use authorization code for one approved consent. */
export async function issueAuthorizationCode(args: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  state: McpState;
  user: User;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await args.state.set(
    codeKey(code),
    authorizationCodeSchema.parse({
      clientId: args.clientId,
      codeChallenge: args.codeChallenge,
      grantId: randomUUID(),
      redirectUri: args.redirectUri,
      resource: args.resource,
      scope: MCP_SCOPE,
      user: args.user,
    }),
    CODE_TTL_MS,
  );
  return code;
}
