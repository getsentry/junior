import { describe, expect, it } from "vitest";
import { GLOBAL_RUNTIME_DEPENDENCIES } from "@/chat/sandbox/runtime-dependencies";

describe("global sandbox runtime dependencies", () => {
  it("provisions the command-line tools used by core sandbox tools", () => {
    expect(GLOBAL_RUNTIME_DEPENDENCIES).toEqual(
      expect.arrayContaining([
        { type: "system", package: "docker" },
        { type: "system", package: "ripgrep" },
      ]),
    );
  });
});
