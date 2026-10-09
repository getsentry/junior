import {
  pluginUserPageContentSchema,
  type PluginApiRouteRequestContext,
  type PluginRouteApp,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { getGoogleAccount, type GoogleDb } from "../src/store";
import {
  ACCOUNT_EMAIL,
  ADMIN_EMAIL,
  TOOL_SCOPE,
  CLIENT_ID,
  createGoogleDb,
  idToken,
  stubGoogleEnv,
} from "./fixture";

const PREFIX = "https://junior.example.com/api/plugins/google";

/** Plugin route context for a dashboard user. Core reads `isAdmin` from the stored user. */
function session(
  email: string,
  isAdmin = email === ADMIN_EMAIL,
): PluginApiRouteRequestContext {
  return {
    auth: { user: { email, emailVerified: true, isAdmin } },
    pluginName: "google",
  };
}

async function readSetupPage(db: GoogleDb) {
  const page = googlePlugin().userPages?.find((item) => item.id === "account");
  if (!page) throw new Error("expected the Google admin page");
  expect(page.navigation).toBe("admin");
  return pluginUserPageContentSchema.parse(
    await page.read({ db } as never, { limit: 20 }),
  ).records[0]!;
}

function setupRoutes(db: GoogleDb): PluginRouteApp {
  const app = googlePlugin().hooks!.apiRoutes!({
    db,
  } as never);
  if (!app) throw new Error("expected setup routes");
  return app;
}

/** Start sign-in and return what the callback needs, like a browser would. */
async function startSignIn(app: PluginRouteApp) {
  const response = await app.fetch(
    // Junior strips the plugin prefix before calling plugin routes.
    new Request("https://junior.example.com/oauth/start"),
    session(ADMIN_EMAIL),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { cookie, location, state: location.searchParams.get("state")! };
}

function callback(app: PluginRouteApp, cookie: string, state: string) {
  return app.fetch(
    new Request(
      `https://junior.example.com/oauth/callback?state=${state}&code=auth-code`,
      { headers: { cookie } },
    ),
    session(ADMIN_EMAIL),
  );
}

function googleTokenEndpoint(
  claims: Record<string, unknown>,
  scope = TOOL_SCOPE,
) {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "access-token",
        expires_in: 3600,
        id_token: idToken({
          aud: CLIENT_ID,
          email_verified: true,
          iss: "https://accounts.google.com",
          ...claims,
        }),
        refresh_token: "refresh-token",
        scope: `openid https://www.googleapis.com/auth/userinfo.email ${scope}`,
      });
    }
    if (href === "https://oauth2.googleapis.com/revoke") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Google account setup", () => {
  let fixture: Awaited<ReturnType<typeof createGoogleDb>>;

  beforeEach(async () => {
    stubGoogleEnv();
    fixture = await createGoogleDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.close();
  });

  it("lets only Junior admins start or finish sign-in", async () => {
    const app = setupRoutes(fixture.db());
    for (const path of ["/oauth/start", "/oauth/callback?state=x&code=y"]) {
      const response = await app.fetch(
        new Request(`https://junior.example.com${path}`),
        session("someone@example.com"),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("junior admin grant");
    }
    // An unverified email is refused even with the admin role.
    const unverified = await app.fetch(
      new Request("https://junior.example.com/oauth/start"),
      {
        auth: {
          user: { email: ADMIN_EMAIL, emailVerified: false, isAdmin: true },
        },
        pluginName: "google",
      },
    );
    expect(unverified.status).toBe(403);
  });

  it("connects the configured account through Google sign-in", async () => {
    const app = setupRoutes(fixture.db());
    const before = await readSetupPage(fixture.db());
    expect(before).toMatchObject({
      title: ACCOUNT_EMAIL,
      actions: [
        {
          href: "/api/plugins/google/oauth/start",
          label: "Connect",
          method: "GET",
        },
      ],
    });
    expect(before.metadata).toBeUndefined();

    const { cookie, location, state } = await startSignIn(app);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("login_hint")).toBe(ACCOUNT_EMAIL);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${PREFIX}/oauth/callback`,
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("access_type")).toBe("offline");

    const fetch = googleTokenEndpoint({ email: ACCOUNT_EMAIL });
    const response = await callback(app, cookie, state);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`Junior now acts as <code>${ACCOUNT_EMAIL}</code>`);
    expect(body).not.toContain("refresh-token");

    const exchange = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
    expect(exchange.get("redirect_uri")).toBe(`${PREFIX}/oauth/callback`);
    expect(exchange.get("code_verifier")).toBe(cookie.split(".")[1]);

    const stored = await getGoogleAccount(fixture.db(), ACCOUNT_EMAIL);
    expect(stored).toMatchObject({
      connectedBy: ADMIN_EMAIL,
      refreshToken: "refresh-token",
    });

    const after = await readSetupPage(fixture.db());
    expect(after.actions?.[0]?.label).toBe("Reconnect");
    expect(after.metadata).toContainEqual({
      label: "Connected by",
      value: ADMIN_EMAIL,
    });
    expect(JSON.stringify(after)).not.toContain("refresh-token");
  });

  it("rejects a sign-in that did not start in this browser", async () => {
    const app = setupRoutes(fixture.db());
    const { cookie } = await startSignIn(app);
    const fetch = googleTokenEndpoint({ email: ACCOUNT_EMAIL });

    const response = await callback(app, cookie, "forged-state");

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await getGoogleAccount(fixture.db(), ACCOUNT_EMAIL)).toBeUndefined();
  });

  it("refuses and revokes a grant for the wrong account or missing scopes", async () => {
    const app = setupRoutes(fixture.db());

    const wrongAccount = await startSignIn(app);
    const fetch = googleTokenEndpoint({ email: ADMIN_EMAIL });
    const wrong = await callback(app, wrongAccount.cookie, wrongAccount.state);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain(`Sign in as ${ACCOUNT_EMAIL} instead`);
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://oauth2.googleapis.com/revoke",
    );

    const partial = await startSignIn(app);
    googleTokenEndpoint(
      { email: ACCOUNT_EMAIL },
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    );
    const missing = await callback(app, partial.cookie, partial.state);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("calendar.events.owned");

    expect(await getGoogleAccount(fixture.db(), ACCOUNT_EMAIL)).toBeUndefined();
  });
});
