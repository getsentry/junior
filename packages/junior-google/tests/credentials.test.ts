import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import type {
  EgressHookContext,
  IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googlePlugin } from "../src";
import { getGoogleAccount, saveGoogleAccount } from "../src/store";
import { newEditableFile } from "../src/tools/editable-file";
import { googleApiRequest } from "../src/tools/shared";
import {
  ACCOUNT_EMAIL,
  ADMIN_EMAIL,
  API_SCOPES,
  createGoogleDb,
  stubGoogleEnv,
} from "./fixture";

const hooks = googlePlugin().hooks!;

function grantFor(request: EgressHookContext["request"]) {
  return hooks.grantForEgress!({ request } as EgressHookContext);
}

describe("Google egress policy", () => {
  it("refuses a change to an existing file without the file that the requester check returned", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const path = "/v1/presentations/1DeCkIdAbCdEfGh:batchUpdate";
    const edit = (editable?: ReturnType<typeof newEditableFile>) =>
      googleApiRequest(
        { egress: { fetch } },
        {
          body: { requests: [] },
          ...(editable ? { editable } : undefined),
          operation: "google.slides.presentation.batchUpdate",
          path,
        },
      );

    await expect(edit()).rejects.toThrow(
      "google.slides.presentation.batchUpdate changes a file, so it needs the file that requireEditableFile checked.",
    );
    await expect(
      edit(newEditableFile({ fileId: "1OtHeRfIlEiDxyz" }, "Other")),
    ).rejects.toThrow("needs the file that requireEditableFile checked");
    expect(fetch).not.toHaveBeenCalled();

    // The checked id must be the changed file id, not part of the path.
    const checked = newEditableFile({ fileId: "1DeCkIdAbCdEfGh" }, "Roadmap");
    const other = "1OtHeRfIlEiDxyz";
    for (const [operation, otherPath] of [
      [
        "google.slides.presentation.batchUpdate",
        `/v1/presentations/1DeCkIdAbCdEfGh/../${other}:batchUpdate`,
      ],
      [
        "google.slides.presentation.batchUpdate",
        "/v1/presentations/1DeCkIdAbCdEfGhXYZ:batchUpdate",
      ],
      [
        "google.slides.presentation.batchUpdate",
        `/v1/presentations/${other}:batchUpdate?x=/1DeCkIdAbCdEfGh`,
      ],
      [
        "google.drive.permission.delete",
        `/drive/v3/files/${other}/permissions/1DeCkIdAbCdEfGh`,
      ],
    ] as const) {
      await expect(
        googleApiRequest(
          { egress: { fetch } },
          { editable: checked, operation, path: otherPath },
        ),
      ).rejects.toThrow("needs the file that requireEditableFile checked");
    }
    // A hand-made file did not pass the requester check.
    await expect(
      edit({
        ref: { fileId: "1DeCkIdAbCdEfGh" },
        title: "Roadmap",
        webViewLink: undefined,
      }),
    ).rejects.toThrow("needs the file that requireEditableFile checked");
    expect(fetch).not.toHaveBeenCalled();

    await edit(checked);
    expect(fetch).toHaveBeenCalledOnce();
  });

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
    // Each operation is bound to the host of its own Google API.
    expect(() =>
      grantFor({
        method: "GET",
        operation: "google.sheets.spreadsheet.get",
        url: "https://www.googleapis.com/v4/spreadsheets/1AbCdEfGhIjK",
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
      scope: API_SCOPES,
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
          "www.googleapis.com",
          "docs.googleapis.com",
          "sheets.googleapis.com",
          "slides.googleapis.com",
        ].map((domain) => ({
          domain,
          headers: { Authorization: "Bearer access-token" },
        })),
      },
    });
    const body = new URLSearchParams(String(fetch.mock.calls[0][1]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
  });

  it("forgets a revoked grant so status shows it needs reconnecting", async () => {
    await saveGoogleAccount(fixture.db(), {
      accountEmail: ACCOUNT_EMAIL,
      connectedAtMs: Date.now(),
      connectedBy: ADMIN_EMAIL,
      refreshToken: "refresh-token",
      scope: API_SCOPES,
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
