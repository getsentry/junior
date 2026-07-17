import { describe, expect, it } from "vitest";
import { isSandboxUnavailableError } from "@/chat/sandbox/errors";

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
