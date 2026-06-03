import { describe, expect, it } from "vitest";
import { globToRegex } from "@/build/glob-to-regex";

describe("globToRegex", () => {
  it.each([
    { glob: "*.js", input: "foo.js", expected: true },
    { glob: "*.js", input: "foo.ts", expected: false },
    { glob: "*.js", input: "path/foo.js", expected: true },
    { glob: "provider-*.js", input: "provider-openai.js", expected: true },
    { glob: "provider-*.js", input: "other.js", expected: false },
    { glob: "exact.js", input: "exact.js", expected: true },
    { glob: "exact.js", input: "not-exact.js", expected: false },
    { glob: "file.test+1.js", input: "file.test+1.js", expected: true },
    { glob: "*", input: "anything", expected: true },
  ])("$glob matches $input -> $expected", ({ glob, input, expected }) => {
    expect(globToRegex(glob).test(input)).toBe(expected);
  });
});
