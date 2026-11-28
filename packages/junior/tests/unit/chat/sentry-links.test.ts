import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDsn = {
  host: string;
  path?: string;
  port?: string;
  projectId: string;
  protocol: "http" | "https";
};

const { sentryDsn } = vi.hoisted(() => ({
  sentryDsn: { current: undefined as MockDsn | undefined },
}));

vi.mock("@/chat/sentry", () => ({
  getClient: () => ({
    getDsn: () => sentryDsn.current,
  }),
}));

import {
  buildSentryEventUrl,
  formatSentryEventReference,
} from "@/chat/sentry-links";
import { useConfig } from "../../fixtures/config";

function mockSentryClient(dsn: MockDsn) {
  sentryDsn.current = dsn;
}

beforeEach(() => {
  sentryDsn.current = undefined;
});

describe("sentry links", () => {
  it("builds SaaS event urls with org subdomain and project", () => {
    useConfig({}, { SENTRY_ORG_SLUG: "my-org" });
    mockSentryClient({
      protocol: "https",
      host: "o123.ingest.us.sentry.io",
      projectId: "4501",
    });

    expect(buildSentryEventUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://my-org.sentry.io/issues/?project=4501&query=0123456789abcdef0123456789abcdef",
    );
  });

  it("builds self-hosted event urls under /organizations/{slug}", () => {
    useConfig({}, { SENTRY_ORG_SLUG: "my-org" });
    mockSentryClient({
      protocol: "https",
      host: "sentry.example.com",
      projectId: "4501",
    });

    expect(buildSentryEventUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://sentry.example.com/organizations/my-org/issues/?project=4501&query=0123456789abcdef0123456789abcdef",
    );
  });

  it("omits event urls when Sentry config is incomplete", () => {
    useConfig({}, { SENTRY_ORG_SLUG: undefined });
    mockSentryClient({
      protocol: "https",
      host: "o123.ingest.sentry.io",
      projectId: "4501",
    });

    expect(
      buildSentryEventUrl("0123456789abcdef0123456789abcdef"),
    ).toBeUndefined();
    expect(formatSentryEventReference("0123456789abcdef0123456789abcdef")).toBe(
      "`event_id=0123456789abcdef0123456789abcdef`",
    );
  });

  it("links failure references to the Sentry event", () => {
    useConfig({}, { SENTRY_ORG_SLUG: "my-org" });
    mockSentryClient({
      protocol: "https",
      host: "o123.ingest.us.sentry.io",
      projectId: "4501",
    });

    expect(formatSentryEventReference("0123456789abcdef0123456789abcdef")).toBe(
      "[event_id=0123456789abcdef0123456789abcdef](https://my-org.sentry.io/issues/?project=4501&query=0123456789abcdef0123456789abcdef)",
    );
  });
});
