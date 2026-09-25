import { describe, expect, it } from "vitest";
import {
  tryWorkspaceRepoCheckoutPath,
  workspaceRepoCheckoutPath,
} from "@/chat/workspaces/checkout-path";

describe("workspaceRepoCheckoutPath", () => {
  it("places repositories under repos/{name}", () => {
    expect(workspaceRepoCheckoutPath("getsentry/sentry")).toBe("repos/sentry");
    expect(workspaceRepoCheckoutPath("getsentry/skills")).toBe("repos/skills");
  });

  it("rejects invalid repository names", () => {
    expect(() => workspaceRepoCheckoutPath("")).toThrow(
      "Invalid repository name for checkout path",
    );
    expect(() => workspaceRepoCheckoutPath("getsentry/..")).toThrow(
      "Invalid repository name for checkout path",
    );
  });
});

describe("tryWorkspaceRepoCheckoutPath", () => {
  it("returns undefined for malformed repository names", () => {
    expect(tryWorkspaceRepoCheckoutPath("")).toBeUndefined();
    expect(tryWorkspaceRepoCheckoutPath("getsentry/..")).toBeUndefined();
    expect(tryWorkspaceRepoCheckoutPath("getsentry/bad name")).toBeUndefined();
  });

  it("returns the fixed checkout path for valid names", () => {
    expect(tryWorkspaceRepoCheckoutPath("getsentry/sentry")).toBe(
      "repos/sentry",
    );
  });
});
