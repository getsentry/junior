import { describe, expect, it } from "vitest";

import {
  parseSearchParamEnum,
  pathWithSearch,
} from "../src/client/searchParams";

describe("search params", () => {
  it("keeps the active query string on same-page paths", () => {
    expect(pathWithSearch("/tasks", "?scope=public&q=deploy")).toBe(
      "/tasks?scope=public&q=deploy",
    );
    expect(
      pathWithSearch(
        "/memories/library",
        new URLSearchParams("filter=private"),
      ),
    ).toBe("/memories/library?filter=private");
    expect(pathWithSearch("/tasks", "")).toBe("/tasks");
  });

  it("merges instead of double-appending when the path already has a query", () => {
    expect(pathWithSearch("/memories/library?filter=private", "?q=deploy")).toBe(
      "/memories/library?q=deploy&filter=private",
    );
    expect(
      pathWithSearch("/tasks/list?range=7", new URLSearchParams("range=30&q=ops")),
    ).toBe("/tasks/list?range=7&q=ops");
    expect(pathWithSearch("/tasks?scope=public", "")).toBe(
      "/tasks?scope=public",
    );
  });

  it("accepts only allowed enum values", () => {
    expect(parseSearchParamEnum("public", ["mine", "public"] as const)).toBe(
      "public",
    );
    expect(parseSearchParamEnum("nope", ["mine", "public"] as const)).toBe(
      undefined,
    );
    expect(parseSearchParamEnum("  ", ["mine", "public"] as const)).toBe(
      undefined,
    );
  });
});
