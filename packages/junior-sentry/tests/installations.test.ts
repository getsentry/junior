import { createHmac } from "node:crypto";
import type {
  EventInput,
  PluginCache,
  PluginGrant,
  PluginHooks,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentryPlugin } from "../src";
import { createSentryDb, memoryCache } from "./fixture";

const CLIENT_ID = "junior-client-id";
const CLIENT_SECRET = "junior-client-secret";
const INSTALLATION_UUID = "a8e5d37a-696c-4c54-adb5-b3f28d64c7de";
const OTHER_INSTALLATION_UUID = "0b3b8a4e-2f3c-4f53-9d55-6b1f0c7a1e10";

function hooks(): PluginHooks {
  const plugin = sentryPlugin();
  if (!plugin.hooks) throw new Error("Sentry plugin has no hooks");
  return plugin.hooks;
}

function signed(
  body: unknown,
  resource: string,
  secret = CLIENT_SECRET,
): Request {
  const rawBody = JSON.stringify(body);
  return new Request("https://junior.example.com/api/webhooks/sentry", {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "request-id": "delivery-1",
      "sentry-hook-resource": resource,
      "sentry-hook-signature": createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex"),
    },
    method: "POST",
  });
}

function installationBody(
  action: "created" | "deleted",
  uuid = INSTALLATION_UUID,
  org = "sentry",
) {
  return {
    action,
    actor: { id: 1, name: "Sentry Admin", type: "user" },
    data: {
      installation: {
        app: { slug: "junior", uuid: "2ebf071f-28df-4989-aca9-c37c763b278f" },
        code: "grant-code",
        organization: { slug: org },
        status: "pending",
        uuid,
      },
    },
    installation: { uuid },
  };
}

function issueBody(uuid = INSTALLATION_UUID) {
  return {
    action: "created",
    data: {
      issue: {
        id: "7513266773",
        project: { slug: "junior" },
        url: "https://sentry.io/api/0/organizations/sentry/issues/7513266773/",
      },
    },
    installation: { uuid },
  };
}

function tokenResponse(token: string): Response {
  return Response.json({
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    refreshToken: "unused-refresh-token",
    token,
  });
}

/** Verify a client JWT the same way Sentry does: HS256 with the client secret. */
function jwtClaims(authorization: string | null): Record<string, unknown> {
  const [header, claims, signature] = (authorization ?? "")
    .replace(/^Bearer /, "")
    .split(".");
  const expected = createHmac("sha256", CLIENT_SECRET)
    .update(`${header}.${claims}`)
    .digest("base64url");
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(claims!, "base64url").toString());
}

describe("Sentry public integration installations", () => {
  let fixture: Awaited<ReturnType<typeof createSentryDb>>;
  let cache: PluginCache;
  let events: EventInput[];
  let fetchMock: ReturnType<typeof vi.fn>;

  function route() {
    const [webhook] =
      hooks().routes?.({
        cache,
        db: fixture.db(),
        events: {
          async publish(event: EventInput) {
            events.push(event);
          },
        },
      } as never) ?? [];
    if (!webhook) throw new Error("Sentry plugin has no webhook route");
    return webhook;
  }

  async function grantFor(url: string, method = "GET") {
    return await hooks().grantForEgress?.({
      cache,
      db: fixture.db(),
      request: { method, url },
    } as never);
  }

  async function issue(grant: PluginGrant) {
    return await hooks().issueCredential?.({
      cache,
      db: fixture.db(),
      grant,
    } as never);
  }

  async function install(uuid = INSTALLATION_UUID, org = "sentry") {
    fetchMock.mockResolvedValueOnce(tokenResponse(`token-${org}`));
    const response = await route().handler(
      signed(installationBody("created", uuid, org), "installation"),
    );
    expect(response.status).toBe(202);
  }

  beforeEach(async () => {
    vi.stubEnv("SENTRY_APP_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("SENTRY_APP_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("SENTRY_READ_TOKEN", "");
    vi.stubEnv("SENTRY_WEBHOOK_SECRET", "internal-secret");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fixture = await createSentryDb();
    cache = memoryCache();
    events = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.close();
  });

  it("exchanges the grant code and reads the installed org with its token", async () => {
    await install();

    const [exchangeUrl, exchange] = fetchMock.mock.calls[0]!;
    expect(exchangeUrl).toBe(
      `https://sentry.io/api/0/sentry-app-installations/${INSTALLATION_UUID}/authorizations/`,
    );
    expect(JSON.parse(exchange.body)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "grant-code",
      grant_type: "authorization_code",
    });

    const grant = await grantFor(
      "https://us.sentry.io/api/0/organizations/Sentry/issues/",
    );
    expect(grant).toEqual({
      access: "read",
      leaseScope: `installation:${INSTALLATION_UUID}`,
      name: "org-read",
      reason: "sentry.org-read",
    });
    await expect(issue(grant!)).resolves.toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: expect.arrayContaining([
          {
            domain: "us.sentry.io",
            headers: { Authorization: "Bearer token-sentry" },
          },
        ]),
      },
    });
    // The exchanged token is shared, so no second token request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints a new token with a client JWT when none is cached", async () => {
    await install();
    cache = memoryCache();
    fetchMock.mockResolvedValueOnce(tokenResponse("minted-token"));

    const grant = await grantFor(
      "https://sentry.io/api/0/projects/sentry/junior/",
    );
    await expect(issue(grant!)).resolves.toMatchObject({
      lease: {
        headerTransforms: expect.arrayContaining([
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer minted-token" },
          },
        ]),
      },
    });

    const [, mint] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(mint.body)).toEqual({
      grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer",
    });
    expect(jwtClaims(new Headers(mint.headers).get("authorization"))).toEqual(
      expect.objectContaining({ iss: CLIENT_ID, sub: CLIENT_ID }),
    );
  });

  it("denies reads of an org without an installation", async () => {
    await install();

    await expect(
      grantFor("https://sentry.io/api/0/organizations/other/issues/"),
    ).rejects.toThrow('Junior is not installed in the Sentry org "other".');
  });

  it("uses the only installation for paths without an org, and denies them when there are more", async () => {
    await install();
    await expect(
      grantFor("https://sentry.io/api/0/issues/123/"),
    ).resolves.toMatchObject({
      leaseScope: `installation:${INSTALLATION_UUID}`,
    });

    await install(OTHER_INSTALLATION_UUID, "other");
    await expect(
      grantFor("https://sentry.io/api/0/issues/123/"),
    ).rejects.toThrow("the Sentry API path must name the org");
    await expect(
      grantFor("https://sentry.io/api/0/teams/other/backend/"),
    ).resolves.toMatchObject({
      leaseScope: `installation:${OTHER_INSTALLATION_UUID}`,
    });
  });

  it("uses the internal integration token for reads that no installation covers", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "org-read-token");
    await install(OTHER_INSTALLATION_UUID, "other");

    const unscoped = await grantFor("https://sentry.io/api/0/issues/123/");
    expect(unscoped).not.toHaveProperty("leaseScope");
    await expect(issue(unscoped!)).resolves.toMatchObject({
      lease: {
        headerTransforms: expect.arrayContaining([
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer org-read-token" },
          },
        ]),
      },
    });
    await expect(
      grantFor("https://sentry.io/api/0/organizations/sentry/issues/"),
    ).resolves.not.toHaveProperty("leaseScope");
    await expect(
      grantFor("https://sentry.io/api/0/organizations/other/issues/"),
    ).resolves.toMatchObject({
      leaseScope: `installation:${OTHER_INSTALLATION_UUID}`,
    });
  });

  it("keeps writes on user OAuth", async () => {
    await install();

    await expect(
      grantFor("https://sentry.io/api/0/organizations/sentry/issues/1/", "PUT"),
    ).resolves.toBeUndefined();
  });

  it("publishes events only from active installations", async () => {
    await install();

    const accepted = await route().handler(signed(issueBody(), "issue"));
    const unknown = await route().handler(
      signed(issueBody(OTHER_INSTALLATION_UUID), "issue"),
    );
    // The internal integration still signs its own deliveries.
    const internal = await route().handler(
      signed(issueBody("internal-uuid"), "issue", "internal-secret"),
    );

    expect([accepted.status, unknown.status, internal.status]).toEqual([
      202, 202, 202,
    ]);
    await expect(unknown.text()).resolves.toBe("Ignored");
    expect(events.map((event) => event.identifier)).toEqual([
      "sentry/junior#7513266773",
      "sentry/junior",
      "sentry/junior#7513266773",
      "sentry/junior",
    ]);
  });

  it("takes the org of an event from its installation, not from the payload", async () => {
    await install(OTHER_INSTALLATION_UUID, "acme");

    // The payload URLs name the org "sentry".
    await route().handler(signed(issueBody(OTHER_INSTALLATION_UUID), "issue"));

    expect(events.map((event) => [event.identifier, event.data?.org])).toEqual([
      ["acme/junior#7513266773", "acme"],
      ["acme/junior", "acme"],
    ]);
  });

  it("removes an uninstalled org and ignores a late install retry", async () => {
    await install();
    await route().handler(signed(installationBody("deleted"), "installation"));

    await expect(
      grantFor("https://sentry.io/api/0/organizations/sentry/issues/"),
    ).resolves.toBeUndefined();
    const lateRetry = await route().handler(
      signed(installationBody("created"), "installation"),
    );
    expect(lateRetry.status).toBe(202);
    await expect(
      grantFor("https://sentry.io/api/0/organizations/sentry/issues/"),
    ).resolves.toBeUndefined();
    const delivery = await route().handler(signed(issueBody(), "issue"));
    await expect(delivery.text()).resolves.toBe("Ignored");
  });

  it("does not accept installation webhooks signed by the internal integration", async () => {
    const response = await route().handler(
      signed(installationBody("created"), "installation", "internal-secret"),
    );

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("Ignored");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
