import { describe, expect, it } from "vitest";
import { parseCodeChangeTitle } from "../src/code-change-titles/parse";
import { parseReleaseCategories } from "../src/code-change-titles/release-config";

const CUSTOM_RELEASE_YML = `
changelog:
  exclude:
    labels: [skip-changelog]
  categories:
    - title: "Deprecations 🏗️"
      labels: [deprecation]
      commit_patterns:
        - "^(?<type>deprecate(?:\\\\((?<scope>[^)]+)\\\\))?!?:\\\\s*)"
    - title: Features
      commit_patterns:
        - "^(?<type>feat(?:\\\\((?<scope>[^)]+)\\\\))?!?:\\\\s*)"
`;

describe("code change title parts", () => {
  it.each([
    ["feat: Add retries", { text: "Add retries", type: "Feature" }],
    [
      "fix(api): handle empty body",
      { scope: "api", text: "Handle empty body", type: "Fix" },
    ],
    [
      "feat(api)!: Drop v1 routes",
      { breaking: true, scope: "api", text: "Drop v1 routes", type: "Feature" },
    ],
    ["wip!: try something", { breaking: true, text: "Try something" }],
    ["FEAT(Inbox): Shout", { scope: "Inbox", text: "Shout", type: "Feature" }],
    ["docs: Fix typo (#123)", { text: "Fix typo", type: "Docs" }],
    ["ref: Split module", { text: "Split module", type: "Refactor" }],
    ["tests: Cover parser", { text: "Cover parser", type: "Test" }],
    ["ci: Pin actions", { text: "Pin actions", type: "CI" }],
    [
      'Revert "feat: Add retries"',
      { text: 'Revert "feat: Add retries"', type: "Revert" },
    ],
    ["feat: ", { text: "feat: ", type: "Feature" }],
  ])("parses %j", (title, parts) => {
    expect(parseCodeChangeTitle(title)).toEqual(parts);
  });

  it("gives no parts to a title without a conventional prefix", () => {
    expect(parseCodeChangeTitle("Add the Inbox notice")).toBeUndefined();
    expect(parseCodeChangeTitle("wip: not a known type")).toBeUndefined();
  });

  it("uses a repository's categories instead of the defaults", () => {
    const categories = parseReleaseCategories(CUSTOM_RELEASE_YML);
    expect(
      parseCodeChangeTitle("deprecate(sdk): Old option", categories),
    ).toEqual({ scope: "sdk", text: "Old option", type: "Deprecations" });
    expect(parseCodeChangeTitle("feat: New thing", categories)).toEqual({
      text: "New thing",
      type: "Feature",
    });
    // The repository has no fix category, so the defaults do not apply.
    expect(parseCodeChangeTitle("fix: Bug", categories)).toBeUndefined();
    // A breaking title still shows its marker.
    expect(parseCodeChangeTitle("wip!: Thing", categories)).toEqual({
      breaking: true,
      text: "Thing",
    });
  });

  it("keeps the title whole when a repository pattern matches later in it", () => {
    const categories = parseReleaseCategories(`
changelog:
  categories:
    - title: Features
      commit_patterns: ["(?<type>feat:\\\\s*)"]
`);
    expect(parseCodeChangeTitle("[WIP] feat: New thing", categories)).toEqual({
      text: "[WIP] feat: New thing",
      type: "Feature",
    });
  });

  it("matches repository patterns in linear time", () => {
    const categories = parseReleaseCategories(`
changelog:
  categories:
    - title: Nested
      commit_patterns: ["^(a+)+$x"]
    - title: Alternation
      commit_patterns: ["^(a|aa)*b"]
`);
    // A backtracking engine takes exponential time on these titles.
    const started = performance.now();
    expect(parseCodeChangeTitle("a".repeat(256), categories)).toBeUndefined();
    expect(
      parseCodeChangeTitle(`${"a".repeat(255)}!`, categories),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("skips invalid repository patterns", () => {
    const categories = parseReleaseCategories(`
changelog:
  categories:
    - title: Empty
      commit_patterns: [""]
    - title: Anything
      commit_patterns: ["x*"]
    - title: Backreference
      commit_patterns: ["^(a)\\\\1"]
    - title: Invalid
      commit_patterns: ["^(unclosed"]
    - title: Long
      commit_patterns: ["^${"a".repeat(201)}"]
`);
    // No usable category is left, so the defaults apply.
    expect(parseCodeChangeTitle("feat: Thing", categories)).toEqual({
      text: "Thing",
      type: "Feature",
    });
    expect(parseCodeChangeTitle("aaaa", categories)).toBeUndefined();
  });

  it("uses the defaults for a file that does not parse", () => {
    expect(
      parseCodeChangeTitle("fix: Bug", parseReleaseCategories("changelog: [")),
    ).toEqual({ text: "Bug", type: "Fix" });
  });
});
