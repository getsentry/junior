import { describe, expect, it } from "vitest";
import {
  GLOBAL_RUNTIME_DEPENDENCIES,
  GLOBAL_RUNTIME_POSTINSTALL,
} from "@/chat/sandbox/runtime-dependencies";

describe("global sandbox runtime dependencies", () => {
  it("provisions core tools after their package repositories", () => {
    expect(GLOBAL_RUNTIME_DEPENDENCIES).toEqual([
      { type: "system", package: "docker" },
      { type: "system", package: "spal-release" },
      { type: "system", package: "ripgrep" },
    ]);
  });

  it("installs a pinned Docker Compose CLI and plugin", () => {
    expect(GLOBAL_RUNTIME_POSTINSTALL).toHaveLength(1);
    const command = GLOBAL_RUNTIME_POSTINSTALL[0];
    expect(command).toMatchObject({ cmd: "sh", sudo: true });
    expect(command?.args?.join(" ")).toContain("v2.39.4");
    expect(command?.args?.join(" ")).toContain("/usr/local/bin/docker-compose");
    expect(command?.args?.join(" ")).toContain(
      "/usr/local/lib/docker/cli-plugins/docker-compose",
    );
  });
});
