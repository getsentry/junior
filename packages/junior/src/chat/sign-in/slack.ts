/**
 * Slack sign-in through the shared Google sign-in session.
 *
 * Slack sends a person here when they have no recent Google sign-in. The page
 * uses the browser session that the dashboard also uses. When the person has
 * no session, or an old one, it starts a Google sign-in and comes back here.
 * The sign-in counts only when its Google email belongs to the user of the
 * Slack identity that got the link.
 */
import { randomBytes } from "node:crypto";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import {
  findSlackIdentityUserId,
  slackUserHasGoogleSignIn,
} from "@/chat/identities/sql";
import { findUserByEmailFromSql } from "@/chat/plugins/viewer";
import { escapeXml } from "@/chat/xml";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import { isSignInAllowed, type SignInAllowlist } from "./allowlist";
import type { SignInAuth } from "./auth";

export const SLACK_SIGN_IN_PATH = "/api/sign-in/slack";

/** Default time a Google sign-in lets a Slack user use Junior. */
export const DEFAULT_SLACK_SIGN_IN_MAX_AGE_DAYS = 7;

const SIGN_IN_STATE_TTL_MS = 10 * 60 * 1000;

/** What Slack ingress needs to check and request sign-in. */
export interface SlackSignIn {
  baseURL: string;
  maxAgeMs: number;
}

const signInStateSchema = z.object({
  // Set after one Google sign-in, so a failed match cannot loop.
  redirected: z.boolean(),
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
});

function stateKey(state: string): string {
  return `sign-in:v2:${state}`;
}

function page(title: string, message: string, status: number): Response {
  return htmlCallbackResponse(escapeXml(title), escapeXml(message), status);
}

/** Store one Slack sign-in request and return its link. */
export async function createSlackSignInUrl(args: {
  baseURL: string;
  slackTeamId: string;
  slackUserId: string;
  state: StateAdapter;
}): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  await args.state.set(
    stateKey(state),
    {
      redirected: false,
      slackTeamId: args.slackTeamId,
      slackUserId: args.slackUserId,
    } satisfies z.input<typeof signInStateSchema>,
    SIGN_IN_STATE_TTL_MS,
  );
  const url = new URL(SLACK_SIGN_IN_PATH, args.baseURL);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Finish a Slack sign-in when the browser has a recent Google sign-in for the
 * user of the Slack identity. Otherwise start one Google sign-in.
 */
export async function handleSlackSignIn(args: {
  allowlist: SignInAllowlist;
  auth: SignInAuth;
  request: Request;
  signIn: SlackSignIn;
  state: StateAdapter;
}): Promise<Response> {
  const token = new URL(args.request.url).searchParams.get("state");
  const parsed = token
    ? signInStateSchema.safeParse(await args.state.get(stateKey(token)))
    : undefined;
  if (!token || !parsed?.success) {
    return page(
      "Sign-in link expired",
      `Mention ${botConfig.userName} in Slack again to get a new link.`,
      400,
    );
  }
  const stored = parsed.data;
  const session = await args.auth.getSession(args.request);
  const email = session?.user.emailVerified
    ? normalizeIdentityEmail(session.user.email)
    : undefined;
  let failure: Response | undefined;
  if (email && !isSignInAllowed(email, args.allowlist)) {
    failure = page(
      "Account not allowed",
      `${email} cannot use ${botConfig.userName}. Sign in with your work account.`,
      403,
    );
  } else if (email) {
    const executor = getSqlExecutor();
    const userId = await findSlackIdentityUserId(
      executor,
      stored.slackTeamId,
      stored.slackUserId,
    );
    const user = await findUserByEmailFromSql(executor.db(), email);
    if (!userId || user?.id !== userId) {
      failure = page(
        "Slack account does not match",
        `Your Slack email is not ${email}. Sign in with the account that matches your Slack email.`,
        403,
      );
    } else if (
      await slackUserHasGoogleSignIn(executor, {
        signedInSince: new Date(Date.now() - args.signIn.maxAgeMs),
        slackTeamId: stored.slackTeamId,
        slackUserId: stored.slackUserId,
      })
    ) {
      await args.state.delete(stateKey(token));
      return page(
        "You are signed in",
        "Return to Slack and send your message again.",
        200,
      );
    }
  }
  if (stored.redirected) {
    return (
      failure ??
      page(
        "Sign-in failed",
        "Google sign-in did not finish. Sign in with your work account.",
        400,
      )
    );
  }
  // No session, another account, or an old sign-in: sign in with Google once.
  await args.state.set(
    stateKey(token),
    { ...stored, redirected: true } satisfies z.input<typeof signInStateSchema>,
    SIGN_IN_STATE_TTL_MS,
  );
  // Come back to the public URL, not the URL this server received.
  const returnUrl = new URL(SLACK_SIGN_IN_PATH, args.signIn.baseURL);
  returnUrl.searchParams.set("state", token);
  return await args.auth.signInWithGoogle(
    args.request,
    returnUrl.toString(),
    returnUrl.toString(),
  );
}
