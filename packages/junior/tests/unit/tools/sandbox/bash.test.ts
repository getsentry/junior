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

  it("names no program that could echo a value or a script name", () => {
    for (const command of [
      'MSG="deploy acme-corp billing fix" ./run.sh',
      "NOTE='Jane Doe salary' python x.py",
      'GIT_AUTHOR_NAME="Jane Doe" git commit',
      "cd /tmp/x\nhunter2-password",
      "cd x; sk-live-51Habc123 --foo",
      "./acme-q3-layoffs.sh",
    ]) {
      expect(commandProgramName(command)).toBeUndefined();
    }
  });
});
