import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginHooks,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentryPlugin } from "../src";

const ORIGINAL_ENV = { ...process.env };

function hooks(): PluginHooks {
  const plugin = sentryPlugin();
  if (!plugin.hooks) {
    throw new Error("Sentry plugin has no hooks");
  }
  return plugin.hooks;
}

function grantFor(method: string, url: string) {
  return hooks().grantForEgress?.({
    request: { method, url },
  } as EgressHookContext);
}

describe("sentry org read access", () => {
  beforeEach(() => {
    process.env.SENTRY_READ_TOKEN = "org-read-token";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the org read token for reads and user OAuth for writes", async () => {
    const orgRead = {
      name: "org-read",
      access: "read",
      reason: "sentry.org-read",
    };
    await expect(
      grantFor(
        "GET",
        "https://us.sentry.io/api/0/organizations/sentry/issues/",
      ),
    ).resolves.toEqual(orgRead);
    await expect(
      grantFor("GET", "https://sentry.io/api/0/projects/sentry/junior/events/"),
    ).resolves.toEqual(orgRead);
    await expect(
      grantFor("GET", "https://sentry.io/api/0/issues/123/"),
    ).resolves.toEqual(orgRead);
    // Explore queries are GET requests.
    await expect(
      grantFor(
        "GET",
        "https://us.sentry.io/api/0/organizations/sentry/events/?dataset=spans&field=span.op",
      ),
    ).resolves.toEqual(orgRead);

    // Writes and user endpoints keep user OAuth.
    await expect(
      grantFor(
        "PUT",
        "https://sentry.io/api/0/organizations/sentry/issues/123/",
      ),
    ).resolves.toBeUndefined();
    await expect(
      grantFor("GET", "https://sentry.io/api/0/users/me/regions/"),
    ).resolves.toBeUndefined();
  });

  it("issues the configured token for the org read grant", async () => {
    const result = await hooks().issueCredential?.({
      grant: { name: "org-read", access: "read" },
    } as IssueCredentialHookContext);

    expect(result).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer org-read-token" },
          },
          {
            domain: "us.sentry.io",
            headers: { Authorization: "Bearer org-read-token" },
          },
          {
            domain: "de.sentry.io",
            headers: { Authorization: "Bearer org-read-token" },
          },
        ],
      },
    });
  });

  it("keeps every request on user OAuth without a configured token", async () => {
    delete process.env.SENTRY_READ_TOKEN;

    await expect(
      grantFor("GET", "https://sentry.io/api/0/organizations/sentry/issues/"),
    ).resolves.toBeUndefined();
  });
});
