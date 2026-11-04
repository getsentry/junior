import { describe, expect, it } from "vitest";
import { commandProgramName } from "@/chat/tools/sandbox/bash";

describe("commandProgramName", () => {
  it("names the first program and never its arguments", () => {
    expect(commandProgramName("pnpm test --filter junior")).toBe("pnpm");
    expect(commandProgramName("cd repos/junior && git log -1")).toBe("git");
    expect(commandProgramName("TOKEN=abc /usr/bin/curl -H x")).toBe("curl");
    expect(commandProgramName("cd /tmp")).toBeUndefined();
    expect(commandProgramName("(cd /tmp && ls)")).toBeUndefined();
  });
});
