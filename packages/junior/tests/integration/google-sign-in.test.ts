import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { closeDb, getDb } from "@/chat/db";
import { createSignInAuth } from "@/chat/sign-in/auth";
import { juniorIdentities } from "@/db/schema";
import { mswServer } from "../msw/server";

const BASE_URL = "https://junior.example.com";

function createAuth(allowedDomains: string[]) {
  return createSignInAuth({
    agentName: "junior",
    allowedDomains,
    authPath: "/api/auth",
    baseURL: BASE_URL,
    googleClientId: "google-client",
    googleClientSecret: "google-secret",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
  });
}

// Fake Google: the token endpoint returns this ID token.
function useGoogleIdToken(idToken: string) {
  mswServer.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({ id_token: idToken }),
    ),
  );
}

// Unsigned Google ID token with these claims.
type GoogleTestClaims = { email: string; hd?: string; picture?: string };

function googleIdToken(claims: GoogleTestClaims): string {
  const payload = Buffer.from(
    JSON.stringify({
      aud: "google-client",
      email_verified: true,
      iss: "https://accounts.google.com",
      sub: `google-${claims.email}`,
      ...claims,
    }),
  ).toString("base64url");
  return `e30.${payload}.sig`;
}

function useGoogleAccount(claims: GoogleTestClaims) {
  useGoogleIdToken(googleIdToken(claims));
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function startSignIn(auth: ReturnType<typeof createAuth>) {
  const started = await auth.signInWithGoogle(
    new Request(`${BASE_URL}/auth/login`),
    `${BASE_URL}/`,
  );
  return { google: new URL(started.headers.get("location")!), started };
}

/** Start a Google sign-in and come back with a code, like a browser. */
async function signIn(auth: ReturnType<typeof createAuth>) {
  const { google, started } = await startSignIn(auth);
  const callback = new URL(`${BASE_URL}/api/auth/callback/google`);
  callback.searchParams.set("state", google.searchParams.get("state")!);
  callback.searchParams.set("code", "google-code");
  const response = await auth.handler(
    new Request(callback, { headers: { cookie: cookieHeader(started) } }),
  );
  return {
    location: response.headers.get("location") ?? "",
    session: new Request(`${BASE_URL}/`, {
      headers: { cookie: cookieHeader(response) },
    }),
  };
}

describe("Google sign-in", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("accepts only Google Workspace accounts on the allowed domains", async () => {
    // One domain limits the account chooser to it. More domains limit it to
    // Workspace accounts.
    expect(
      (await startSignIn(createAuth(["example.com"]))).google.searchParams.get(
        "hd",
      ),
    ).toBe("example.com");
    const auth = createAuth(["example.com", "example.org"]);
    expect((await startSignIn(auth)).google.searchParams.get("hd")).toBe("*");

    // `hd` decides, not the email: a personal Google account can use any
    // email address, and only Workspace accounts have `hd`.
    for (const claims of [
      { email: "person@example.com" },
      { email: "person@example.com", hd: "contractor.dev" },
    ]) {
      useGoogleAccount(claims);
      const rejected = await signIn(auth);
      expect(rejected.location).toContain("error=unable_to_get_user_info");
      expect(await auth.getSession(rejected.session)).toBeNull();
    }

    // A malformed ID token is a normal sign-in error, not a server error.
    useGoogleIdToken("not-a-jwt");
    const malformed = await signIn(auth);
    expect(malformed.location).toContain("error=unable_to_get_user_info");

    const picture = "https://lh3.googleusercontent.com/a/person=s96-c";
    useGoogleAccount({
      email: "person@example.org",
      hd: "example.org",
      picture,
    });
    const accepted = await signIn(auth);
    expect(accepted.location).toBe(`${BASE_URL}/`);
    expect(await auth.getSession(accepted.session)).toMatchObject({
      user: { email: "person@example.org", emailVerified: true },
    });
    // The sign-in saves the Google photo on the Google identity.
    expect(
      await getDb()
        .select({ avatarUrl: juniorIdentities.avatarUrl })
        .from(juniorIdentities)
        .where(
          eq(juniorIdentities.providerSubjectId, "google-person@example.org"),
        ),
    ).toEqual([{ avatarUrl: picture }]);

    // Direct ID-token sign-in is off, so a client cannot submit its own
    // token, even with claims on an allowed domain.
    const direct = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          idToken: {
            token: googleIdToken({
              email: "person@example.org",
              hd: "example.org",
            }),
          },
        }),
      }),
    );
    expect(await direct.json()).toMatchObject({
      code: "ID_TOKEN_NOT_SUPPORTED",
    });
    expect(direct.headers.getSetCookie()).toEqual([]);
  });
});
