import { describe, expect, it } from "vitest";
import {
  DOCKER_CLI_WRAPPER_SCRIPT,
  DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT,
  DOCKER_ENSURE_SCRIPT,
} from "@/chat/sandbox/docker";
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

  it("installs compose, dockerd ensure helper, and PATH wrappers", () => {
    expect(GLOBAL_RUNTIME_POSTINSTALL).toHaveLength(1);
    const script = GLOBAL_RUNTIME_POSTINSTALL[0]?.args?.[1];
    expect(script).toEqual(expect.any(String));
    expect(script).toContain("docker-compose-linux-");
    expect(script).toContain("/usr/local/libexec/junior-docker-compose");
    expect(script).toContain("/usr/local/bin/junior-ensure-docker");
    expect(script).toContain("/usr/local/bin/docker");
    expect(script).toContain("/usr/local/bin/docker-compose");
    expect(script).toContain("/vercel/sandbox/.junior/bin/docker");
    expect(script).toContain(Buffer.from(DOCKER_ENSURE_SCRIPT, "utf8").toString("base64"));
    expect(script).toContain(
      Buffer.from(DOCKER_CLI_WRAPPER_SCRIPT, "utf8").toString("base64"),
    );
    expect(script).toContain(
      Buffer.from(DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT, "utf8").toString("base64"),
    );
  });
});
