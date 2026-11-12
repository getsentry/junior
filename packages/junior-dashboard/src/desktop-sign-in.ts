// Sign-in for the Junior desktop app (`apps/desktop`). Google blocks its
// sign-in page in embedded webviews, so the app opens this route in the
// system browser with a loopback redirect URI (RFC 8252) and a PKCE
// challenge. After Google sign-in, the browser returns a short-lived code to
// the app. The app redeems it at the token route and sets the returned
// session cookies in its webview.
import type { Env, Hono } from "hono";
import * as z from "zod";
import { dashboardSessionIsAuthorized, type DashboardAuth } from "./auth";
import { renderForbiddenPage } from "./shell";

const NO_STORE = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

// Only IP literals: `localhost` can resolve to another host (RFC 8252 8.3).
const loopbackRedirectSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
    url.port !== "" &&
    !url.username &&
    !url.password
  );
});

const startQuerySchema = z.object({
  code_challenge: z.string().regex(/^[\w-]{43}$/),
  error: z.string().optional(),
  redirect_uri: loopbackRedirectSchema,
  state: z.string().min(1).max(200),
});

const tokenBodySchema = z.object({
  code: z.string().min(1).max(16_384),
  code_verifier: z.string().regex(/^[\w.~-]{43,128}$/),
});

function loopbackRedirect(
  redirectUri: string,
  state: string,
  params: Record<string, string>,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, location: url.toString() },
  });
}

/** Mount the desktop sign-in routes. They run before dashboard auth. */
export function registerDesktopSignInRoutes<E extends Env>(
  app: Hono<E>,
  options: {
    agentName: string;
    allowedDomains: string[];
    auth: DashboardAuth;
    path: string;
  },
): void {
  const { agentName, allowedDomains, auth, path } = options;

  app.get(path, async (c) => {
    const query = startQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return new Response("Invalid desktop sign-in request.", {
        status: 400,
        headers: NO_STORE,
      });
    }
    const { code_challenge, error, redirect_uri, state } = query.data;
    // Better Auth appends `error` to this URL when Google sign-in fails.
    // Report it to the app instead of starting sign-in again in a loop.
    if (error) {
      return loopbackRedirect(redirect_uri, state, { error: "sign_in_failed" });
    }
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return auth.signInWithGoogle(c.req.raw, c.req.url, c.req.url);
    }
    if (!dashboardSessionIsAuthorized(session, allowedDomains)) {
      return renderForbiddenPage(agentName);
    }
    const code = await auth.createDesktopCode(c.req.raw, code_challenge);
    if (!code) {
      throw new Error(
        "Signed-in desktop sign-in request has no session cookie",
      );
    }
    return loopbackRedirect(redirect_uri, state, { code });
  });

  app.post(`${path}/token`, async (c) => {
    const body = tokenBodySchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    const cookies = body.success
      ? await auth.redeemDesktopCode(body.data.code, body.data.code_verifier)
      : undefined;
    if (!cookies) {
      return Response.json(
        { error: "invalid_grant" },
        { status: 400, headers: NO_STORE },
      );
    }
    return Response.json({ cookies }, { headers: NO_STORE });
  });
}
