import { describe, expect, it } from "vitest";
import {
  isAbortError,
  isSandboxApiTransientError,
  isSandboxUnavailableError,
} from "@/chat/sandbox/errors";

describe("isSandboxUnavailableError", () => {
  it("treats an invalid sandbox session token as unavailable", () => {
    const error = Object.assign(new Error("Forbidden"), {
      response: {
        status: 403,
        url: "https://api.vercel.com/v1/sandboxes/sessions",
      },
      json: { invalidToken: true },
    });

    expect(isSandboxUnavailableError(error)).toBe(true);
  });

  it("does not treat an unrelated forbidden response as unavailable", () => {
    const error = Object.assign(new Error("Forbidden"), {
      response: {
        status: 403,
        url: "https://api.vercel.com/v1/projects",
      },
    });

    expect(isSandboxUnavailableError(error)).toBe(false);
  });
});

describe("isAbortError", () => {
  it("recognizes host cancellation without matching setup output", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    expect(isAbortError(abortError)).toBe(true);
    expect(
      isAbortError(new Error("executeAgentRun timed out after 720000ms")),
    ).toBe(true);
    expect(isAbortError(new Error("Transaction aborted"))).toBe(false);
    expect(isAbortError(new Error("npm error signal SIGABORTED"))).toBe(false);
  });
});

describe("isSandboxApiTransientError", () => {
  it("recognizes provider 5xx responses but not permanent client errors", () => {
    const unavailable = Object.assign(new Error("Status code 500 is not ok"), {
      response: { status: 500 },
      json: { error: { code: "internal_server_error" } },
    });
    const missing = Object.assign(new Error("Status code 404 is not ok"), {
      response: { status: 404 },
    });

    expect(isSandboxApiTransientError(unavailable)).toBe(true);
    expect(isSandboxApiTransientError(missing)).toBe(false);
  });
});
