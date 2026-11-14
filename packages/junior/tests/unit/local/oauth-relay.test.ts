import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalOAuthState,
  relayLocalOAuthCallback,
} from "@/chat/local/oauth-relay";

const ORIGINAL_SECRET = process.env["JUNIOR_SECRET"];

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env["JUNIOR_SECRET"];
  } else {
    process.env["JUNIOR_SECRET"] = ORIGINAL_SECRET;
  }
});

/** Flip a middle signature character so JWT verification must reject the state. */
function corruptLocalOAuthState(state: string): string {
  const parts = state.split(".");
  if (parts.length < 4) {
    throw new Error(`unexpected local OAuth state format: ${state}`);
  }
  const signature = parts[3] ?? "";
  if (signature.length < 2) {
    throw new Error(`unexpected local OAuth signature: ${signature}`);
  }
  const index = Math.floor(signature.length / 2);
  const current = signature[index] ?? "a";
  const replacement = current === "A" ? "B" : "A";
  parts[3] = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
  return parts.join(".");
}

describe("local OAuth relay", () => {
  it("redirects a signed provider callback to the owning loopback server", async () => {
    process.env["JUNIOR_SECRET"] = "test-secret";
    const state = await createLocalOAuthState(43123);
    const request = new Request(
      `https://junior.example.com/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}`,
    );

    const response = await relayLocalOAuthCallback(request);

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      `http://127.0.0.1:43123/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}&jr_local_relay=complete`,
    );
  });

  it("rejects tampered and already-relayed state", async () => {
    process.env["JUNIOR_SECRET"] = "test-secret";
    const state = await createLocalOAuthState(43123);
    const tampered = corruptLocalOAuthState(state);

    expect(
      await relayLocalOAuthCallback(
        new Request(
          `https://junior.example.com/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(tampered)}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      await relayLocalOAuthCallback(
        new Request(
          `http://127.0.0.1:43123/api/oauth/callback/github?code=oauth-code&state=${encodeURIComponent(state)}&jr_local_relay=complete`,
        ),
      ),
    ).toBeUndefined();
  });
});
