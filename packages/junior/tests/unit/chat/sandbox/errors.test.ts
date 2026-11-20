import { describe, expect, it } from "vitest";
import { isAbortError, wrapSandboxSetupError } from "@/chat/sandbox/errors";
import { WorkspaceSnapshotNotReadyError } from "@/chat/sandbox/snapshot/not-ready-error";

describe("isAbortError", () => {
  it("recognizes host cancellation without matching setup output", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new Error("Transaction aborted"))).toBe(false);
    expect(isAbortError(new Error("npm error signal SIGABORTED"))).toBe(false);
  });
});

describe("wrapSandboxSetupError", () => {
  it("keeps Workspace snapshot not-ready errors as-is", () => {
    const notReady = new WorkspaceSnapshotNotReadyError("sentry-docs");
    const wrapped = new Error(
      "sandbox setup failed (Workspace sentry-docs snapshot is not ready)",
      {
        cause: notReady,
      },
    );

    expect(wrapSandboxSetupError(notReady)).toBe(notReady);
    expect(wrapSandboxSetupError(wrapped)).toBe(notReady);
  });

  it("still wraps ordinary setup failures", () => {
    const failure = new Error("disk full");
    const wrapped = wrapSandboxSetupError(failure);

    expect(wrapped).not.toBe(failure);
    expect(wrapped.message).toBe("sandbox setup failed (disk full)");
    expect(wrapped.cause).toBe(failure);
  });
});
