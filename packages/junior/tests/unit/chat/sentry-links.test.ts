import { afterEach, describe, expect, it, vi } from "vitest";

type MockDsn = {
  host: string;
  path?: string;
  port?: string;
  projectId: string;
  protocol: "http" | "https";
};

function mockSentryClient(dsn?: MockDsn) {
  vi.doMock("@/chat/sentry", () => ({
    getClient: () => ({
      getDsn: () => dsn,
    }),
  }));
}

async function loadSentryLinks() {
  return await import("@/chat/sentry-links");
}

afterEach(() => {
  delete process.env.SENTRY_ORG_SLUG;
  vi.doUnmock("@/chat/sentry");
  vi.resetModules();
});

describe("sentry links", () => {
  it("builds SaaS event urls with org subdomain and project", async () => {
    process.env.SENTRY_ORG_SLUG = "my-org";
    mockSentryClient({
      protocol: "https",
      host: "o123.ingest.us.sentry.io",
      projectId: "4501",
    });

    const { buildSentryEventUrl } = await loadSentryLinks();

    expect(buildSentryEventUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://my-org.sentry.io/issues/?project=4501&query=0123456789abcdef0123456789abcdef",
    );
  });

  it("builds self-hosted event urls under /organizations/{slug}", async () => {
    process.env.SENTRY_ORG_SLUG = "my-org";
    mockSentryClient({
      protocol: "https",
      host: "sentry.example.com",
      projectId: "4501",
    });

    const { buildSentryEventUrl } = await loadSentryLinks();

    expect(buildSentryEventUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://sentry.example.com/organizations/my-org/issues/?project=4501&query=0123456789abcdef0123456789abcdef",
    );
  });

  it("omits event urls when Sentry config is incomplete", async () => {
    mockSentryClient({
      protocol: "https",
      host: "o123.ingest.sentry.io",
      projectId: "4501",
    });

    const { buildSentryEventUrl } = await loadSentryLinks();

    expect(
      buildSentryEventUrl("0123456789abcdef0123456789abcdef"),
    ).toBeUndefined();
  });
});
