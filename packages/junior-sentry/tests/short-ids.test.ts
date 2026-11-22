import { describe, expect, it } from "vitest";
import { sentryPlugin } from "../src/index.js";

const CONFIG = { org: "sentry", project: "junior" };

function format(text: string, config: Record<string, string> = CONFIG) {
  const hook = sentryPlugin().hooks?.formatMarkdown;
  if (!hook) throw new Error("The Sentry plugin has no formatMarkdown hook");
  return hook({ config, mention: () => undefined, platform: "slack", text });
}

describe("Sentry short id links", () => {
  it("links a short id of the configured project to its issue", () => {
    expect(format("JUNIOR-3ZK is back after the deploy.")).toBe(
      "[JUNIOR-3ZK](https://sentry.sentry.io/issues/JUNIOR-3ZK/) is back after the deploy.",
    );
    expect(
      format("see SENTRY-PYTHON-1A2, again", {
        org: "acme",
        project: "sentry-python",
      }),
    ).toBe(
      "see [SENTRY-PYTHON-1A2](https://acme.sentry.io/issues/SENTRY-PYTHON-1A2/), again",
    );
  });

  it("leaves keys that a tracker or another project could own", () => {
    const text = [
      // All digits: the shape of a Jira or Linear key.
      "JUNIOR-123",
      // Another project, or a tracker team with a base32-looking key.
      "ENG-3ZK",
      // Not Crockford base32, or not the case that Sentry shows.
      "JUNIOR-3IL",
      "junior-3zk",
    ].join("\n");
    expect(format(text)).toBe(text);
  });

  it("leaves short ids in code, links, URLs, and longer words", () => {
    const text = [
      "`JUNIOR-3ZK`",
      "```",
      "JUNIOR-3ZK",
      "```",
      "[the checkout error](https://sentry.sentry.io/issues/JUNIOR-3ZK/)",
      "[JUNIOR-3ZK][ref]",
      "https://sentry.sentry.io/issues/JUNIOR-3ZK/",
      "logs/JUNIOR-3ZK",
      "JUNIOR-3ZK-retry",
      "",
      "[ref]: https://sentry.sentry.io/issues/JUNIOR-3ZK/",
    ].join("\n");
    expect(format(text)).toBe(text);
  });

  it("links nothing without a configured org and project", () => {
    expect(format("JUNIOR-3ZK", { project: "junior" })).toBe("JUNIOR-3ZK");
    expect(format("JUNIOR-3ZK", { org: "sentry" })).toBe("JUNIOR-3ZK");
  });
});
