import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { Skill } from "@/chat/skills";

type JrRpcIssueCommand = {
  kind: "issue";
  capability: string;
  repo: string;
  format: "token" | "env" | "json";
};

type JrRpcExecCommand = {
  kind: "exec";
  capability: string;
  repo: string;
  execCommand: string;
};

export type JrRpcCommand = JrRpcIssueCommand | JrRpcExecCommand;
export type JrRpcToolInput = {
  action: "issue" | "exec";
  capability: string;
  repo: string;
  format?: "token" | "env" | "json";
  command?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hintForCredentialError(detail: string): string | undefined {
  if (/error:1E08010C|DECODER routines::unsupported/i.test(detail)) {
    return "Host signer could not decode GITHUB_APP_PRIVATE_KEY. Ensure it is an RSA PEM key (raw PEM, escaped newlines, or base64-encoded PEM) and that host Node/OpenSSL versions are compatible.";
  }
  if (/Missing GITHUB_APP_PRIVATE_KEY/i.test(detail)) {
    return "Set GITHUB_APP_PRIVATE_KEY for the host runtime credential broker.";
  }
  if (/Missing GITHUB_APP_ID/i.test(detail)) {
    return "Set GITHUB_APP_ID for the host runtime credential broker.";
  }
  return undefined;
}

function buildCredentialIssueError(command: JrRpcCommand, error: unknown): Error {
  const detail = getErrorMessage(error);
  const hint = hintForCredentialError(detail);
  const context = `jrRpc ${command.kind} failed (capability=${command.capability}, repo=${command.repo})`;
  const message = hint ? `${context}: ${detail}\nHint: ${hint}` : `${context}: ${detail}`;
  return new Error(message, { cause: error });
}

function buildExecError(command: JrRpcExecCommand, error: unknown): Error {
  const detail = getErrorMessage(error);
  return new Error(
    `jrRpc exec failed while running nested command (capability=${command.capability}, repo=${command.repo}): ${detail}`,
    { cause: error }
  );
}

export function mapJrRpcToolInputToCommand(input: JrRpcToolInput): JrRpcCommand {
  const capability = input.capability.trim();
  if (!capability) {
    throw new Error("jrRpc requires a non-empty capability");
  }

  const repo = input.repo.trim();
  if (!repo) {
    throw new Error("jrRpc requires a non-empty repo");
  }

  if (input.action === "exec") {
    const execCommand = input.command?.trim();
    if (!execCommand) {
      throw new Error("jrRpc exec requires a non-empty command");
    }
    return {
      kind: "exec",
      capability,
      repo,
      execCommand
    };
  }

  return {
    kind: "issue",
    capability,
    repo,
    format: input.format ?? "token"
  };
}

function formatIssueOutput(
  format: "token" | "env" | "json",
  metadata: { capability: string; repo: string; provider: string; expiresAt: string; envKeys: string[] }
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        ok: true,
        capability: metadata.capability,
        repo: metadata.repo,
        provider: metadata.provider,
        expiresAt: metadata.expiresAt,
        envKeys: metadata.envKeys
      },
      null,
      2
    );
  }
  if (format === "env") {
    return metadata.envKeys.map((key) => `${key}=[REDACTED]`).join("\n");
  }
  return `issued provider=${metadata.provider} capability=${metadata.capability} repo=${metadata.repo} expiresAt=${metadata.expiresAt} envKeys=${metadata.envKeys.join(",")}`;
}

export async function executeJrRpcCommand(params: {
  command: JrRpcCommand;
  activeSkill: Skill | null;
  capabilityRuntime: SkillCapabilityRuntime;
  executeBashWithEnv: (command: string, env: Record<string, string>) => Promise<unknown>;
}): Promise<unknown> {
  const { command, activeSkill, capabilityRuntime } = params;
  let lease: Awaited<ReturnType<SkillCapabilityRuntime["issueCapabilityLease"]>>;
  try {
    lease = await capabilityRuntime.issueCapabilityLease({
      activeSkill,
      capability: command.capability,
      repoRef: command.repo,
      reason: `skill:${activeSkill?.name ?? "unknown"}:jrRpc:${command.kind}`
    });
  } catch (error) {
    throw buildCredentialIssueError(command, error);
  }

  if (command.kind === "exec") {
    try {
      return await params.executeBashWithEnv(command.execCommand, lease.env);
    } catch (error) {
      throw buildExecError(command, error);
    }
  }

  return {
    ok: true,
    command: "jrRpc issue",
    cwd: "/",
    exit_code: 0,
    signal: null,
    timed_out: false,
    stdout: formatIssueOutput(command.format, {
      capability: command.capability,
      repo: command.repo,
      provider: lease.provider,
      expiresAt: lease.expiresAt,
      envKeys: Object.keys(lease.env)
    }),
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false
  };
}
