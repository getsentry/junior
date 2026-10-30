import type {
  EgressHookContext,
  IssueCredentialHookContext,
  PluginCache,
  PluginHooks,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentryPlugin } from "../src";

const ORIGINAL_ENV = { ...process.env };

const cache: PluginCache = {
  async getOrLoad(_key, load) {
    return (await load()).value;
  },
};

function hooks(): PluginHooks {
  const plugin = sentryPlugin();
  if (!plugin.hooks) {
    throw new Error("Sentry plugin has no hooks");
  }
  return plugin.hooks;
}

async function grantFor(method: string, url: string) {
  return await hooks().grantForEgress?.({
    cache,
    log: { error() {}, info() {}, warn() {} },
    request: { method, url },
  } as EgressHookContext);
}

describe("sentry org read access", () => {
  beforeEach(() => {
    process.env.SENTRY_READ_TOKEN = "org-read-token";
    // Sentry lists only the installing org for an internal integration token.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ id: "1", slug: "sentry" }])),
    );
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("uses the org read token for reads of its org and user OAuth otherwise", async () => {
    const orgRead = {
      name: "org-read",
      access: "read",
      reason: "sentry.org-read",
    };
    expect(
      await grantFor(
        "GET",
        "https://us.sentry.io/api/0/organizations/sentry/issues/",
      ),
    ).toEqual(orgRead);
    expect(
      await grantFor(
        "GET",
        "https://sentry.io/api/0/projects/sentry/junior/events/",
      ),
    ).toEqual(orgRead);
    expect(
      await grantFor("GET", "https://sentry.io/api/0/issues/123/"),
    ).toEqual(orgRead);
    expect(
      await grantFor("GET", "https://sentry.io/api/0/organizations/1/"),
    ).toEqual(orgRead);
    // Explore queries are GET requests.
    expect(
      await grantFor(
        "GET",
        "https://us.sentry.io/api/0/organizations/sentry/events/?dataset=spans&field=span.op",
      ),
    ).toEqual(orgRead);

    // Writes and user endpoints keep user OAuth.
    expect(
      await grantFor(
        "PUT",
        "https://sentry.io/api/0/organizations/sentry/issues/123/",
      ),
    ).toBeUndefined();
    expect(
      await grantFor("GET", "https://sentry.io/api/0/users/me/regions/"),
    ).toBeUndefined();

    // Reads of other orgs keep user OAuth.
    expect(
      await grantFor(
        "GET",
        "https://us.sentry.io/api/0/organizations/sentry-developer-experience/issues/",
      ),
    ).toBeUndefined();
    expect(
      await grantFor("GET", "https://sentry.io/api/0/projects/other/app/"),
    ).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://sentry.io/api/0/organizations/",
      expect.objectContaining({
        headers: { Authorization: "Bearer org-read-token" },
      }),
    );
  });

  it("keeps the org read token when the org lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    expect(
      await grantFor(
        "GET",
        "https://sentry.io/api/0/organizations/sentry/issues/",
      ),
    ).toMatchObject({ name: "org-read" });
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

    expect(
      await grantFor(
        "GET",
        "https://sentry.io/api/0/organizations/sentry/issues/",
      ),
    ).toBeUndefined();
  });
});
