import { afterEach, describe, expect, it } from "vitest";
import { appendGitHubFooter } from "../src/tools/footer.js";

const originalEnv = { ...process.env };
const conversationId = "slack:C123:1712345.0001";

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GitHub conversation footer", () => {
  it("prefers the Junior dashboard when enabled", () => {
    process.env.SENTRY_DSN = "https://public@o450000.ingest.sentry.io/12345";
    process.env.SENTRY_ORG_SLUG = "acme";

    expect(
      appendGitHubFooter(
        "PR body",
        conversationId,
        "https://junior.example.com/conversations/slack%3AC123%3A1712345.0001",
      ),
    ).toContain(
      "[View Junior Session](https://junior.example.com/conversations/slack%3AC123%3A1712345.0001)",
    );
  });

  it("falls back to Sentry when the dashboard is disabled", () => {
    process.env.SENTRY_DSN = "https://public@o450000.ingest.sentry.io/12345";
    process.env.SENTRY_ORG_SLUG = "acme";

    expect(appendGitHubFooter("PR body", conversationId)).toContain(
      "[View Junior Session in Sentry](https://acme.sentry.io/explore/conversations/slack%3AC123%3A1712345.0001/?project=12345)",
    );
  });

  it("omits the footer when neither dashboard nor Sentry is enabled", () => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ORG_SLUG;

    expect(appendGitHubFooter("PR body", conversationId)).toBe("PR body");
  });
});
