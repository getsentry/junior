import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { logInfo } from "@/chat/logging";
import type { Skill } from "@/chat/skills";

type JrRpcDeps = {
  activeSkill: Skill | null;
  channelConfiguration?: ChannelConfigurationService;
  requesterId?: string;
  onConfigurationValueChanged?: (
    key: string,
    value: unknown | undefined,
  ) => void;
};

const JR_RPC_USAGE = [
  "jr-rpc config get <key>",
  "jr-rpc config set <key> <value> [--json]",
  "jr-rpc config unset <key>",
  "jr-rpc config list [--prefix <value>]",
].join("\n");

function commandResult(input: {
  stdout?: unknown;
  stderr?: string;
  exitCode: number;
}) {
  let stdout = "";
  if (typeof input.stdout === "string") {
    stdout = input.stdout;
  } else if (input.stdout !== undefined) {
    stdout = `${JSON.stringify(input.stdout, null, 2)}\n`;
  }
  return {
    stdout,
    stderr: input.stderr ?? "",
    exitCode: input.exitCode,
  };
}

function requireChannelConfiguration(
  deps: JrRpcDeps,
):
  | { ok: true; configuration: ChannelConfigurationService }
  | { ok: false; result: ReturnType<typeof commandResult> } {
  if (deps.channelConfiguration) {
    return { ok: true, configuration: deps.channelConfiguration };
  }
  return {
    ok: false,
    result: commandResult({
      stderr: "jr-rpc config commands require active conversation context\n",
      exitCode: 1,
    }),
  };
}

function parsePrefixFlag(
  extras: string[],
): { ok: true; prefix?: string } | { ok: false; error: string } {
  if (extras.length === 0) {
    return { ok: true };
  }
  if (extras.length === 2 && extras[0] === "--prefix") {
    const prefix = extras[1]?.trim();
    return { ok: true, ...(prefix ? { prefix } : {}) };
  }
  if (extras.length === 1 && extras[0].startsWith("--prefix=")) {
    const prefix = extras[0].slice("--prefix=".length).trim();
    return { ok: true, ...(prefix ? { prefix } : {}) };
  }
  return {
    ok: false,
    error: "jr-rpc config list accepts optional --prefix <value>\n",
  };
}

async function handleConfigCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const subverb = (args[0] ?? "").trim();
  const configurationResult = requireChannelConfiguration(deps);
  if (!configurationResult.ok) {
    return configurationResult.result;
  }
  const configuration = configurationResult.configuration;

  if (subverb === "get") {
    const key = (args[1] ?? "").trim();
    if (!key || args.length !== 2) {
      return commandResult({
        stderr: `Usage:\n${JR_RPC_USAGE}\n`,
        exitCode: 2,
      });
    }
    const entry = await configuration.get(key);
    return commandResult({
      stdout: entry
        ? {
            ok: true,
            key: entry.key,
            scope: entry.scope,
            value: entry.value,
            updatedAt: entry.updatedAt,
            updatedBy: entry.updatedBy,
            source: entry.source,
          }
        : {
            ok: true,
            key,
            found: false,
          },
      exitCode: 0,
    });
  }

  if (subverb === "set") {
    const key = (args[1] ?? "").trim();
    const valueArg = args[2];
    const extras = args.slice(3);
    if (!key || valueArg === undefined) {
      return commandResult({
        stderr: `Usage:\n${JR_RPC_USAGE}\n`,
        exitCode: 2,
      });
    }

    let parseAsJson = false;
    if (extras.length > 0) {
      if (extras.length === 1 && extras[0] === "--json") {
        parseAsJson = true;
      } else {
        return commandResult({
          stderr: `Usage:\n${JR_RPC_USAGE}\n`,
          exitCode: 2,
        });
      }
    }

    let value: unknown = valueArg;
    if (parseAsJson) {
      try {
        value = JSON.parse(valueArg);
      } catch (error) {
        return commandResult({
          stderr: `Invalid JSON value for jr-rpc config set --json: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 2,
        });
      }
    }

    try {
      const entry = await configuration.set({
        key,
        value,
        updatedBy: deps.requesterId,
        source: "jr-rpc",
      });
      logInfo(
        "jr_rpc_config_set",
        {},
        {
          "app.config.key": entry.key,
          "app.config.scope": entry.scope,
          "app.config.source": entry.source ?? "jr-rpc",
          ...(deps.activeSkill?.name
            ? { "app.skill.name": deps.activeSkill.name }
            : {}),
        },
        "Set channel configuration via jr-rpc",
      );
      deps.onConfigurationValueChanged?.(entry.key, entry.value);
      return commandResult({
        stdout: {
          ok: true,
          key: entry.key,
          scope: entry.scope,
          value: entry.value,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          source: entry.source,
        },
        exitCode: 0,
      });
    } catch (error) {
      return commandResult({
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      });
    }
  }

  if (subverb === "unset") {
    const key = (args[1] ?? "").trim();
    if (!key || args.length !== 2) {
      return commandResult({
        stderr: `Usage:\n${JR_RPC_USAGE}\n`,
        exitCode: 2,
      });
    }
    const deleted = await configuration.unset(key);
    if (deleted) {
      logInfo(
        "jr_rpc_config_unset",
        {},
        {
          "app.config.key": key,
          ...(deps.activeSkill?.name
            ? { "app.skill.name": deps.activeSkill.name }
            : {}),
        },
        "Unset channel configuration via jr-rpc",
      );
      deps.onConfigurationValueChanged?.(key, undefined);
    }
    return commandResult({
      stdout: {
        ok: true,
        key,
        deleted,
      },
      exitCode: 0,
    });
  }

  if (subverb === "list") {
    const prefixResult = parsePrefixFlag(args.slice(1));
    if (!prefixResult.ok) {
      return commandResult({
        stderr: prefixResult.error,
        exitCode: 2,
      });
    }
    const entries = prefixResult.prefix
      ? await configuration.list({ prefix: prefixResult.prefix })
      : await configuration.list({});
    return commandResult({
      stdout: {
        ok: true,
        entries: entries.map((entry) => ({
          key: entry.key,
          scope: entry.scope,
          value: entry.value,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          source: entry.source,
        })),
      },
      exitCode: 0,
    });
  }

  return commandResult({
    stderr: `Usage:\n${JR_RPC_USAGE}\n`,
    exitCode: 2,
  });
}

type JrRpcParseResult =
  | { handled: false }
  | { handled: true; args: string[] }
  | { handled: true; error: string };

const JR_RPC_SHELL_OPERATORS = new Set([";", "|", "&", "<", ">", "(", ")"]);

function parseStandaloneJrRpcArgs(command: string): JrRpcParseResult {
  const normalized = command.trim();
  if (!normalized.startsWith("jr-rpc")) {
    return { handled: false };
  }

  const boundary = normalized.at("jr-rpc".length);
  if (boundary && !/\s/.test(boundary)) {
    return !/[A-Za-z0-9._+-]/.test(boundary)
      ? {
          handled: true,
          error: "jr-rpc commands must be standalone\n",
        }
      : { handled: false };
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  const pushToken = () => {
    if (!tokenStarted) {
      return;
    }
    args.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string;

    if (char === "\n" || char === "\r") {
      return {
        handled: true,
        error: "jr-rpc commands must be standalone\n",
      };
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (quote === '"' && char === "\\") {
        const next = normalized[index + 1];
        if (next === undefined) {
          return {
            handled: true,
            error: "jr-rpc commands contain an unterminated escape\n",
          };
        }
        current += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (
      char === "\\" ||
      char === "$" ||
      char === "`" ||
      JR_RPC_SHELL_OPERATORS.has(char)
    ) {
      return {
        handled: true,
        error: "jr-rpc commands must be standalone\n",
      };
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    return {
      handled: true,
      error: "jr-rpc commands contain an unterminated quote\n",
    };
  }

  pushToken();
  return { handled: true, args };
}

async function executeJrRpcCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const executable = args[0]?.trim();
  if (executable !== "jr-rpc") {
    return commandResult({
      stderr: "jr-rpc commands must start with jr-rpc\n",
      exitCode: 2,
    });
  }

  const verb = (args[1] ?? "").trim();
  if (verb === "config") {
    return handleConfigCommand(args.slice(2), deps);
  }

  return commandResult({
    stderr: `Unsupported jr-rpc command. Use:\n${JR_RPC_USAGE}\n`,
    exitCode: 2,
  });
}

/** Handle standalone jr-rpc bridge commands before sandbox bash starts. */
export async function maybeExecuteJrRpcBridgeCommand(
  command: string,
  deps: JrRpcDeps,
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
  const parsed = parseStandaloneJrRpcArgs(normalized);
  if (!parsed.handled) {
    return { handled: false };
  }
  const execResult =
    "error" in parsed
      ? commandResult({ stderr: parsed.error, exitCode: 2 })
      : await executeJrRpcCommand(parsed.args, deps);
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
      stderr_truncated: false,
    },
  };
}
