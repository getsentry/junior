import { describe, expect, it } from "vitest";
import { GitHubRequestError } from "../src/credential-support.js";
import { logFailOpenFailure } from "../src/webhooks/fail-open-log.js";

function capture(error: unknown) {
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  logFailOpenFailure(
    {
      error: (_message, metadata) => logs.push(["error", metadata]),
      warn: (_message, metadata) => logs.push(["warn", metadata]),
    },
    "GitHub check suite load failed",
    error,
    { repository: "getsentry/junior" },
  );
  return logs;
}

describe("logFailOpenFailure", () => {
  it("logs a GitHub 5xx as a warning with the status", () => {
    expect(capture(new GitHubRequestError("Bad gateway", 502))).toEqual([
      [
        "warn",
        {
          errorType: "GitHubRequestError",
          "http.response.status_code": 502,
          repository: "getsentry/junior",
        },
      ],
    ]);
  });

  it("logs other failures as errors", () => {
    expect(capture(new GitHubRequestError("Not found", 404))).toEqual([
      [
        "error",
        { errorType: "GitHubRequestError", repository: "getsentry/junior" },
      ],
    ]);
    expect(capture(new TypeError("bad response"))[0]?.[0]).toBe("error");
  });
});
