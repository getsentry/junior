import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { closeDb } from "@/chat/db";
import { createSignInAuth } from "@/chat/sign-in/auth";
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

function useGoogleAccount(claims: { email: string; hd?: string }) {
  const payload = Buffer.from(
    JSON.stringify({
      aud: "google-client",
      email_verified: true,
      iss: "https://accounts.google.com",
      sub: `google-${claims.email}`,
      ...claims,
    }),
  ).toString("base64url");
  useGoogleIdToken(`e30.${payload}.sig`);
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

    useGoogleAccount({ email: "person@example.org", hd: "example.org" });
    const accepted = await signIn(auth);
    expect(accepted.location).toBe(`${BASE_URL}/`);
    expect(await auth.getSession(accepted.session)).toMatchObject({
      user: { email: "person@example.org", emailVerified: true },
    });
  });
});
