import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { closeDb, getDb } from "@/chat/db";
import { createSignInAuth } from "@/chat/sign-in/auth";
import { juniorIdentities } from "@/db/schema";
import { mswServer } from "../msw/server";

const BASE_URL = "https://junior.example.com";
const RETRY_URL = `${BASE_URL}/auth/login?next=%2Fconversations`;

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
    RETRY_URL,
  );
  return { google: new URL(started.headers.get("location")!), started };
}

/**
 * Start a Google sign-in and come back with a code, like a browser. Pass the
 * cookies of another started sign-in to act like a second tab.
 */
async function signIn(
  auth: ReturnType<typeof createAuth>,
  otherTab?: Response,
) {
  const { google, started: thisTab } = await startSignIn(auth);
  const started = otherTab ?? thisTab;
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
    vi.useRealTimers();
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
      expect(rejected.location).toBe(
        `${RETRY_URL}&error=unable_to_get_user_info`,
      );
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

    // A second tab replaces the state cookie, so the first tab's callback
    // fails. Better Auth then uses the retry URL in the cookie, not `/`.
    const { started: secondTab } = await startSignIn(auth);
    const staleTab = await signIn(auth, secondTab);
    expect(staleTab.location).toContain(`${RETRY_URL}&error=`);

    // Each sign-in saves the current Google photo on the Google identity.
    const savedPhoto = async () =>
      await getDb()
        .select({ avatarUrl: juniorIdentities.avatarUrl })
        .from(juniorIdentities)
        .where(
          eq(juniorIdentities.providerSubjectId, "google-person@example.org"),
        );
    expect(await savedPhoto()).toEqual([{ avatarUrl: picture }]);
    const newPicture = "https://lh3.googleusercontent.com/a/new=s96-c";
    useGoogleAccount({
      email: "person@example.org",
      hd: "example.org",
      picture: newPicture,
    });
    await signIn(auth);
    expect(await savedPhoto()).toEqual([{ avatarUrl: newPicture }]);
    useGoogleAccount({ email: "person@example.org", hd: "example.org" });
    await signIn(auth);
    expect(await savedPhoto()).toEqual([{ avatarUrl: null }]);

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

  it("moves a browser session to the desktop app with a PKCE-bound code", async () => {
    const auth = createAuth(["example.org"]);
    useGoogleAccount({ email: "person@example.org", hd: "example.org" });
    const { session } = await signIn(auth);
    const verifier = "desktop-verifier-0123456789abcdef0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    expect(
      await auth.createDesktopCode(new Request(`${BASE_URL}/`), challenge),
    ).toBeUndefined();
    const code = await auth.createDesktopCode(session, challenge);
    if (!code) throw new Error("expected a desktop sign-in code");

    // Only the app that holds the verifier can redeem the code.
    expect(
      await auth.redeemDesktopCode(code, "other-verifier"),
    ).toBeUndefined();
    expect(await auth.redeemDesktopCode(`${code}x`, verifier)).toBeUndefined();
    const cookies = await auth.redeemDesktopCode(code, verifier);
    const desktop = new Request(`${BASE_URL}/`, {
      headers: {
        cookie: (cookies ?? [])
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; "),
      },
    });
    expect(await auth.getSession(desktop)).toMatchObject({
      user: { email: "person@example.org", emailVerified: true },
    });

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    expect(await auth.redeemDesktopCode(code, verifier)).toBeUndefined();
  });
});
