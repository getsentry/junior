import { describe, expect, it } from "vitest";
import { GLOBAL_RUNTIME_DEPENDENCIES } from "@/chat/sandbox/runtime-dependencies";

describe("global sandbox runtime dependencies", () => {
  it("provisions core tools after their package repositories", () => {
    expect(GLOBAL_RUNTIME_DEPENDENCIES).toEqual([
      { type: "system", package: "docker" },
      { type: "system", package: "spal-release" },
      { type: "system", package: "ripgrep" },
    ]);
  });
});
