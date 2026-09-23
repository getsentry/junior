import {
  EgressPolicyDenied,
  type PluginHooks,
} from "@sentry/junior-plugin-api";

const DOMAINS = ["sentry.io", "us.sentry.io", "de.sentry.io"];
const GRANT = "service-read";

/** Read-only Sentry API access with an operator-provided service token. */
export const sentryServiceHooks: Pick<
  PluginHooks,
  "grantForEgress" | "issueCredential" | "onEgressResponse"
> = {
  grantForEgress({ request }) {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      !DOMAINS.includes(url.hostname) ||
      (url.port !== "" && url.port !== "443") ||
      !url.pathname.startsWith("/api/0/") ||
      !["GET", "HEAD"].includes(request.method.toUpperCase())
    ) {
      throw new EgressPolicyDenied(
        "The Sentry service connection permits read-only API requests (GET or HEAD) only.",
      );
    }
    return { access: "read", name: GRANT };
  },
  issueCredential({ grant }) {
    if (grant.name !== GRANT || grant.access !== "read") {
      return {
        type: "unavailable",
        message: "The Sentry service connection requires a read-only grant.",
      };
    }
    const token = process.env.SENTRY_SERVICE_TOKEN?.trim();
    if (!token) {
      return {
        type: "unavailable",
        message:
          "The Sentry service connection is not configured. An operator must set SENTRY_SERVICE_TOKEN on the host. User OAuth cannot repair this connection.",
      };
    }
    return {
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        headerTransforms: DOMAINS.map((domain) => ({
          domain,
          headers: { Authorization: `Bearer ${token}` },
        })),
      },
    };
  },
  onEgressResponse({ response, permissionDenied }) {
    if (response.status === 401 || response.status === 403) {
      permissionDenied(
        "Sentry rejected the service connection. An operator must check SENTRY_SERVICE_TOKEN and its organization, project access, and read permissions. User OAuth cannot repair this connection.",
      );
    }
  },
};
