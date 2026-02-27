import { Bash, defineCommand } from "just-bash";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { parseRepoTarget } from "@/chat/capabilities/target";
import type { Skill } from "@/chat/skills";

type JrRpcDeps = {
  capabilityRuntime: SkillCapabilityRuntime;
  activeSkill: Skill | null;
};

function createJrRpcCommand(deps: JrRpcDeps) {
  return defineCommand("jr-rpc", async (args) => {
    const usage = "jr-rpc issue-credential <capability> [--repo <owner/repo>]\n";
    const verb = args[0];
    if (verb !== "issue-credential") {
      return {
        stdout: "",
        stderr: `Unsupported jr-rpc command. Use: ${usage}`,
        exitCode: 2
      };
    }
    const capability = (args[1] ?? "").trim();
    if (!capability) {
      return {
        stdout: "",
        stderr: "jr-rpc issue-credential requires a capability argument\n",
        exitCode: 2
      };
    }
    let repoRef: string | undefined;
    const extras = args.slice(2);
    if (extras.length > 0) {
      if (extras.length === 2 && extras[0] === "--repo") {
        repoRef = extras[1];
      } else if (extras.length === 1 && extras[0].startsWith("--repo=")) {
        repoRef = extras[0].slice("--repo=".length);
      } else {
        return {
          stdout: "",
          stderr: `jr-rpc issue-credential requires exactly one capability argument and optional --repo <owner/repo>\n`,
          exitCode: 2
        };
      }
      if (!parseRepoTarget(repoRef ?? "")) {
        return {
          stdout: "",
          stderr: "jr-rpc issue-credential --repo must be in owner/repo format\n",
          exitCode: 2
        };
      }
    }
    let outcome: { reused: boolean; expiresAt: string };
    try {
      outcome = await deps.capabilityRuntime.enableCapabilityForTurn({
        activeSkill: deps.activeSkill,
        capability,
        ...(repoRef ? { repoRef } : {}),
        reason: `skill:${deps.activeSkill?.name ?? "unknown"}:jr-rpc:issue-credential`
      });
    } catch (error) {
      return {
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1
      };
    }
    return {
      stdout: `${outcome.reused ? "credential_reused" : "credential_enabled"} capability=${capability} expiresAt=${outcome.expiresAt}\n`,
      stderr: "",
      exitCode: 0
    };
  });
}

export async function maybeExecuteJrRpcCustomCommand(
  command: string,
  deps: JrRpcDeps
): Promise<
  | {
      handled: false;
    }
  | {
      handled: true;
      result: {
        ok: boolean;
        command: string;
        cwd: string;
        exit_code: number;
        signal: null;
        timed_out: boolean;
        stdout: string;
        stderr: string;
        stdout_truncated: boolean;
        stderr_truncated: boolean;
      };
    }
> {
  const normalized = command.trim();
  if (!/^jr-rpc(?:\s|$)/.test(normalized)) {
    return { handled: false };
  }
  const shell = new Bash({
    customCommands: [createJrRpcCommand(deps)]
  });
  const execResult = await shell.exec(normalized);
  return {
    handled: true,
    result: {
      ok: execResult.exitCode === 0,
      command: normalized,
      cwd: "/",
      exit_code: execResult.exitCode,
      signal: null,
      timed_out: false,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      stdout_truncated: false,
      stderr_truncated: false
    }
  };
}
