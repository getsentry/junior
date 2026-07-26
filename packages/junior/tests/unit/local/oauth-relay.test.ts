import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalOAuthState,
  localOAuthRelayPort,
  relayLocalOAuthCallback,
} from "@/chat/local/oauth-relay";

const ORIGINAL_SECRET = process.env.JUNIOR_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.JUNIOR_SECRET;
  } else {
    process.env.JUNIOR_SECRET = ORIGINAL_SECRET;
  }
});

describe("local OAuth relay", () => {
  it("redirects a signed provider callback to the owning loopback server", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const state = createLocalOAuthState(43123);
    const request = new Request(
      `https://junior.example.com/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}`,
    );

    const response = relayLocalOAuthCallback(request);

    expect(localOAuthRelayPort(state)).toBe(43123);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      `http://127.0.0.1:43123/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}&jr_local_relay=complete`,
    );
  });

  it("rejects tampered and already-relayed state", () => {
    process.env.JUNIOR_SECRET = "test-secret";
    const state = createLocalOAuthState(43123);
    const tampered = state.replace("43123", "43124");

    expect(localOAuthRelayPort(tampered)).toBeUndefined();
    expect(
      relayLocalOAuthCallback(
        new Request(
          `https://junior.example.com/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(tampered)}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      relayLocalOAuthCallback(
        new Request(
          `http://127.0.0.1:43123/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}&jr_local_relay=complete`,
        ),
      ),
    ).toBeUndefined();
  });
});
