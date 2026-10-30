import { describe, expect, it } from "vitest";
import { vercelSandboxErrors } from "@/chat/sandbox/vercel/errors";

describe("vercelSandboxErrors.isUnavailable", () => {
  it("treats an invalid sandbox session token as unavailable", () => {
    const error = Object.assign(new Error("Forbidden"), {
      response: {
        status: 403,
        url: "https://api.vercel.com/v1/sandboxes/sessions",
      },
      json: { invalidToken: true },
    });

    expect(vercelSandboxErrors.isUnavailable(error)).toBe(true);
  });

  it("does not treat an unrelated forbidden response as unavailable", () => {
    const error = Object.assign(new Error("Forbidden"), {
      response: {
        status: 403,
        url: "https://api.vercel.com/v1/projects",
      },
    });

    expect(vercelSandboxErrors.isUnavailable(error)).toBe(false);
  });
});

describe("vercelSandboxErrors.isTransient", () => {
  it("recognizes provider 5xx responses but not permanent client errors", () => {
    const unavailable = Object.assign(new Error("Status code 500 is not ok"), {
      response: { status: 500 },
      json: { error: { code: "internal_server_error" } },
    });
    const missing = Object.assign(new Error("Status code 404 is not ok"), {
      response: { status: 404 },
    });

    expect(vercelSandboxErrors.isTransient(unavailable)).toBe(true);
    expect(vercelSandboxErrors.isTransient(missing)).toBe(false);
  });
});
