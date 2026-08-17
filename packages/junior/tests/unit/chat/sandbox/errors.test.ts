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
  it("treats AbortError and aborted messages as cancellation", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new Error("API Turn cancelled / aborted"))).toBe(true);
    expect(
      isAbortError(new Error("wrapper", { cause: abortError })),
    ).toBe(true);
  });

  it("does not treat ordinary setup failures as cancellation", () => {
    expect(isAbortError(new Error("snapshot setup failed: exit 1"))).toBe(
      false,
    );
  });
});

describe("isSandboxApiTransientError", () => {
  it("treats Sandbox API 500 responses as transient", () => {
    const error = Object.assign(new Error("Status code 500 is not ok"), {
      response: {
        status: 500,
        statusText: "Internal Server Error",
        url: "https://vercel.com/api/v2/sandboxes/sessions/sbx_x/cmd",
      },
      json: {
        error: {
          code: "internal_server_error",
          message: "An unexpected internal error occurred",
        },
      },
    });

    expect(isSandboxApiTransientError(error)).toBe(true);
    expect(
      isSandboxApiTransientError(
        new Error("sandbox setup failed (status=500)", { cause: error }),
      ),
    ).toBe(true);
  });

  it("does not treat permanent client errors as transient", () => {
    const error = Object.assign(new Error("Status code 404 is not ok"), {
      response: {
        status: 404,
        url: "https://vercel.com/api/v2/sandboxes/sessions/sbx_x",
      },
    });

    expect(isSandboxApiTransientError(error)).toBe(false);
  });
});
