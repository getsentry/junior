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

function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(raw.replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

function parseFlagValue(tokens: string[], index: number): { value: string; nextIndex: number } {
  const value = tokens[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${tokens[index]}`);
  }
  return { value, nextIndex: index + 2 };
}

export function parseJrRpcCommand(command: string): JrRpcCommand | null {
  const trimmed = command.trim();
  const delimiterMatch = /\s--\s/.exec(trimmed);
  const delimiterIndex = delimiterMatch?.index ?? -1;
  const delimiterLength = delimiterMatch?.[0].length ?? 0;
  const hasExecDelimiter = delimiterIndex >= 0;
  const prefix = hasExecDelimiter ? trimmed.slice(0, delimiterIndex).trim() : trimmed;
  const execTail = hasExecDelimiter ? trimmed.slice(delimiterIndex + delimiterLength) : "";

  const tokens = tokenizeShell(prefix);
  if (tokens.length < 3 || tokens[0] !== "jr-rpc" || tokens[1] !== "credential") {
    return null;
  }

  const action = tokens[2];
  if (action !== "issue" && action !== "exec") {
    throw new Error(`Unsupported jr-rpc credential action: ${action}`);
  }

  let capability: string | undefined;
  let repo: string | undefined;
  let format: "token" | "env" | "json" = "token";
  let index = 3;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--cap") {
      const parsed = parseFlagValue(tokens, index);
      capability = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (token === "--repo") {
      const parsed = parseFlagValue(tokens, index);
      repo = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (token === "--format") {
      const parsed = parseFlagValue(tokens, index);
      if (parsed.value !== "token" && parsed.value !== "env" && parsed.value !== "json") {
        throw new Error(`Unsupported jr-rpc format: ${parsed.value}`);
      }
      format = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown jr-rpc option: ${token}`);
  }

  if (!capability) {
    throw new Error("jr-rpc credential command requires --cap");
  }
  if (!repo) {
    throw new Error("jr-rpc credential command requires --repo");
  }

  if (action === "exec") {
    const execCommand = execTail.trim();
    if (!hasExecDelimiter || execCommand.length === 0) {
      throw new Error("jr-rpc credential exec requires a command after --");
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
    format
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
  const lease = await capabilityRuntime.issueCapabilityLease({
    activeSkill,
    capability: command.capability,
    repoRef: command.repo,
    reason: `skill:${activeSkill?.name ?? "unknown"}:jr-rpc:${command.kind}`
  });

  if (command.kind === "exec") {
    return await params.executeBashWithEnv(command.execCommand, lease.env);
  }

  return {
    ok: true,
    command: "jr-rpc credential issue",
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
