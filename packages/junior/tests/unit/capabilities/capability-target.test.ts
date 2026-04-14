import { describe, expect, it } from "vitest";
import { extractCapabilityTarget } from "@/chat/capabilities/target";

describe("capability target extraction", () => {
  it("extracts repo from --repo flag in command", () => {
    const target = extractCapabilityTarget({
      commandText: 'node script.mjs create --repo getsentry/junior --title "x"',
    });

    expect(target).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("extracts repo from -R alias in command", () => {
    const target = extractCapabilityTarget({
      commandText: "gh issue view 123 -R getsentry/junior --json number,title",
    });

    expect(target).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("extracts repo from invocation args when command lacks repo", () => {
    const target = extractCapabilityTarget({
      commandText: "node script.mjs create --title x",
      invocationArgs: "create --repo getsentry/sentry#123",
    });

    expect(target).toEqual({ owner: "getsentry", repo: "sentry" });
  });

  it("extracts repo regardless of skill name when --repo is present", () => {
    const target = extractCapabilityTarget({
      commandText: "echo hello",
      invocationArgs: "--repo getsentry/junior",
    });

    expect(target).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("does not infer repo from path-like command tokens", () => {
    const target = extractCapabilityTarget({
      commandText: "node script.mjs --body-file /tmp/body.md",
      invocationArgs: "create --title hello",
    });

    expect(target).toBeUndefined();
  });
});
