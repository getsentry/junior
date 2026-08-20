import { describe, expect, it } from "vitest";
import { dedupeConsecutive, redactSecrets, tailLines } from "../src/log";

describe("redactSecrets", () => {
  it("masks a bearer token but keeps surrounding text", () => {
    const out = redactSecrets("Authorization: bearer abc123XYZ.tok_-value");
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain("[REDACTED]");
  });

  it("masks token and password query values but keeps other params", () => {
    const out = redactSecrets(
      "GET /go?token=supersecret&page=2&password=hunter2",
    );
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("page=2");
  });

  it("masks a signed-url signature", () => {
    const out = redactSecrets("https://x/y?X-Goog-Signature=deadbeefcafe&z=1");
    expect(out).not.toContain("deadbeefcafe");
    expect(out).toContain("z=1");
  });

  it("masks non-bearer Authorization schemes", () => {
    const basic = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(basic).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(basic).toContain("[REDACTED]");
    const token = redactSecrets("Authorization: Token ghp_ABCDEFG1234567890");
    expect(token).not.toContain("ghp_ABCDEFG1234567890");
    expect(token).toContain("[REDACTED]");
  });

  it("masks secrets in JSON-quoted keys", () => {
    const out = redactSecrets('{"access_token":"ya29.SECRETVALUE","x":1}');
    expect(out).not.toContain("ya29.SECRETVALUE");
    expect(out).toContain('"x":1');
  });
});

describe("dedupeConsecutive", () => {
  it("collapses a run of digit-varying lines into the first line plus a marker", () => {
    const lines = [
      "waiting for pod 1",
      "waiting for pod 2",
      "waiting for pod 3",
      "waiting for pod 4",
      "done",
    ];
    const result = dedupeConsecutive(lines);
    expect(result.deduped).toBe(true);
    expect(result.lines).toEqual([
      "waiting for pod 1",
      "… 3 more similar lines",
      "done",
    ]);
  });

  it("leaves a short run untouched", () => {
    const lines = ["a", "a", "b"];
    const result = dedupeConsecutive(lines);
    expect(result.deduped).toBe(false);
    expect(result.lines).toEqual(["a", "a", "b"]);
  });
});

describe("tailLines", () => {
  it("returns the last n lines and reports truncation", () => {
    const result = tailLines(["1", "2", "3", "4", "5"], 2);
    expect(result.lines).toEqual(["4", "5"]);
    expect(result.truncated).toBe(true);
  });

  it("returns every line when fewer than n exist", () => {
    const result = tailLines(["1", "2"], 10);
    expect(result.lines).toEqual(["1", "2"]);
    expect(result.truncated).toBe(false);
  });
});
