import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type {
  EgressHookContext,
  IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { getGoogleAccount, saveGoogleAccount } from "../src/store";
import {
  ACCOUNT_EMAIL,
  ADMIN_EMAIL,
  ACCOUNT_SCOPE,
  createGoogleDb,
  stubGoogleEnv,
} from "./fixture";

const hooks = googlePlugin().hooks!;

function grantFor(request: EgressHookContext["request"]) {
  return hooks.grantForEgress!({ request } as EgressHookContext);
}

describe("Google egress policy", () => {
  it("gives the account only to declared plugin operations", () => {
    // Sandbox commands carry no operation.
    expect(() =>
      grantFor({
        method: "GET",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      }),
    ).toThrow(EgressPolicyDenied);
    // A declared operation cannot be reused for a different API path.
    expect(() =>
      grantFor({
        method: "POST",
        operation: "google.calendar.freebusy.query",
        url: "https://www.googleapis.com/drive/v3/files",
      }),
    ).toThrow(EgressPolicyDenied);

    expect(
      grantFor({
        method: "POST",
        operation: "google.calendar.event.create",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
      }),
    ).toMatchObject({ access: "write", name: "account" });
  });

  it("allows only read-only Meet transcript calls", () => {
    expect(
      grantFor({
        method: "GET",
        operation: "google.meet.transcriptEntries.list",
        url: "https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts/t1/entries?pageSize=100",
      }),
    ).toMatchObject({ access: "read", name: "account" });

    for (const request of [
      // A Meet operation cannot reach another Google host.
      {
        method: "GET",
        operation: "google.meet.conferenceRecords.list",
        url: "https://www.googleapis.com/v2/conferenceRecords",
      },
      // No Meet space calls, which can read or change meeting settings.
      {
        method: "GET",
        operation: "google.meet.conferenceRecords.list",
        url: "https://meet.googleapis.com/v2/spaces/abc",
      },
      // No writes, even on a declared path.
      {
        method: "POST",
        operation: "google.meet.transcripts.list",
        url: "https://meet.googleapis.com/v2/conferenceRecords/c1/transcripts",
      },
      // No path tricks to reach another collection.
      {
        method: "GET",
        operation: "google.meet.participants.list",
        url: "https://meet.googleapis.com/v2/conferenceRecords/c1/participants/../recordings",
      },
    ]) {
      expect(() => grantFor(request)).toThrow(EgressPolicyDenied);
    }
  });
});

describe("Google credential issuing", () => {
  let fixture: Awaited<ReturnType<typeof createGoogleDb>>;
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  function issue() {
    return hooks.issueCredential!({
      actor: { type: "user", userId: "user-1" },
      db: fixture.db(),
      grant: { access: "read", name: "account" },
      log,
      plugin: { name: "google" },
      tokens: {},
    } as IssueCredentialHookContext);
  }

  beforeEach(async () => {
    stubGoogleEnv();
    fixture = await createGoogleDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.close();
  });

  it("explains how to connect when no account is stored", async () => {
    const result = await issue();
    expect(result).toMatchObject({ type: "unavailable" });
    expect(result.type === "unavailable" && result.message).toContain(
      "dashboard Admin page",
    );
  });

  it("mints a short-lived bearer for Google APIs from the stored grant", async () => {
    await saveGoogleAccount(fixture.db(), {
      accountEmail: ACCOUNT_EMAIL,
      connectedAtMs: Date.now(),
      connectedBy: ADMIN_EMAIL,
      refreshToken: "refresh-token",
      scope: ACCOUNT_SCOPE,
    });
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "access-token", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await issue();

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        account: { id: ACCOUNT_EMAIL },
        headerTransforms: [
          {
            domain: "www.googleapis.com",
            headers: { Authorization: "Bearer access-token" },
          },
          {
            domain: "meet.googleapis.com",
            headers: { Authorization: "Bearer access-token" },
          },
        ],
      },
    });
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
  });

  it("forgets a revoked grant so status shows it needs reconnecting", async () => {
    await saveGoogleAccount(fixture.db(), {
      accountEmail: ACCOUNT_EMAIL,
      connectedAtMs: Date.now(),
      connectedBy: ADMIN_EMAIL,
      refreshToken: "refresh-token",
      scope: ACCOUNT_SCOPE,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    );

    const result = await issue();

    expect(result).toMatchObject({ type: "unavailable" });
    expect(await getGoogleAccount(fixture.db(), ACCOUNT_EMAIL)).toBeUndefined();
  });
});
