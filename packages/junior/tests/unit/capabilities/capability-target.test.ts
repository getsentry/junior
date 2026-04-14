import { describe, expect, it } from "vitest";
import { extractCapabilityTarget } from "@/chat/capabilities/target";

describe("capability target extraction", () => {
  const repoTarget = {
    type: "repo",
    configKey: "github.repo",
    commandFlags: ["--repo", "-R"],
  };

  it("extracts repo from --repo flag in command", () => {
    const target = extractCapabilityTarget({
      target: repoTarget,
      commandText: 'node script.mjs create --repo getsentry/junior --title "x"',
    });

    expect(target).toEqual({ type: "repo", value: "getsentry/junior" });
  });

  it("extracts repo from -R alias in command", () => {
    const target = extractCapabilityTarget({
      target: repoTarget,
      commandText: "gh issue view 123 -R getsentry/junior --json number,title",
    });

    expect(target).toEqual({ type: "repo", value: "getsentry/junior" });
  });

  it("extracts repo from invocation args when command lacks repo", () => {
    const target = extractCapabilityTarget({
      target: repoTarget,
      commandText: "node script.mjs create --title x",
      invocationArgs: "create --repo getsentry/sentry#123",
    });

    expect(target).toEqual({ type: "repo", value: "getsentry/sentry#123" });
  });

  it("extracts provider-defined target flags regardless of target type", () => {
    const target = extractCapabilityTarget({
      target: {
        type: "project",
        configKey: "sentry.project",
        commandFlags: ["--project"],
      },
      commandText: "echo hello",
      invocationArgs: "--project issue-platform",
    });

    expect(target).toEqual({ type: "project", value: "issue-platform" });
  });

  it("does not infer repo from path-like command tokens", () => {
    const target = extractCapabilityTarget({
      target: repoTarget,
      commandText: "node script.mjs --body-file /tmp/body.md",
      invocationArgs: "create --title hello",
    });

    expect(target).toBeUndefined();
  });
});
