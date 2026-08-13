import { describe, expect, it } from "vitest";
import { workspaceRepoCheckoutPath } from "@/chat/workspaces/checkout-path";

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
