// The `shell-quote` index types patch the global `Array#join` type; this
// subpath has the parser without that.
import parse from "shell-quote/parse.js";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { getAppContext } from "@/app/context";
import { readConversationSpaceConfiguration } from "@/chat/spaces/configuration";

type JrRpcDeps = {
  locationConfiguration?: LocationConfigurationService | undefined;
  /** The Conversation whose Space configuration the reads include. */
  conversationId?: string | undefined;
};

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

type ConfigRow = {
  key: string;
  scope: "location" | "space";
  value: unknown;
  updatedAt?: string;
  updatedBy?: string | undefined;
  source?: string | undefined;
};

/**
 * Read the configuration that the Conversation sets: its Slack channel's
 * and its Space's. A key that both set lists twice, and the Space's value
 * wins, the same as when a Turn resolves its configuration.
 */
async function readConfigRows(
  deps: JrRpcDeps,
): Promise<ConfigRow[] | undefined> {
  if (!deps.locationConfiguration && !deps.conversationId) return undefined;
  const [location, space] = await Promise.all([
    deps.locationConfiguration?.list() ?? [],
    deps.conversationId
      ? readConversationSpaceConfiguration(deps.conversationId)
      : {},
  ]);
  return [
    ...Object.entries(space).map(([key, value]) => ({
      key,
      scope: "space" as const,
      value,
    })),
    ...location.map((entry) => ({
      key: entry.key,
      scope: entry.scope,
      value: entry.value,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
      source: entry.source,
    })),
  ];
}

function parsePrefixFlag(
  extras: string[],
): { ok: true; prefix?: string } | { ok: false; error: string } {
  if (extras.length === 0) {
    return { ok: true };
  }
  if (extras.length === 2 && extras[0] === "--prefix") {
    const prefix = extras[1]?.trim();
    return { ok: true, ...(prefix ? { prefix } : undefined) };
  }
  if (extras.length === 1 && extras[0]?.startsWith("--prefix=")) {
    const prefix = extras[0].slice("--prefix=".length).trim();
    return { ok: true, ...(prefix ? { prefix } : undefined) };
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
  const usage = [
    "jr-rpc config get <key>",
    "jr-rpc config list [--prefix <value>]",
  ].join("\n");
  const subverb = (args[0] ?? "").trim();
  if (subverb === "set" || subverb === "unset") {
    return commandResult({
      stderr:
        "jr-rpc config only reads configuration. Change it with the setConfiguration tool.\n",
      exitCode: 2,
    });
  }
  const rows = await readConfigRows(deps);
  if (!rows) {
    return commandResult({
      stderr: "jr-rpc config commands require active conversation context\n",
      exitCode: 1,
    });
  }

  if (subverb === "get") {
    const key = (args[1] ?? "").trim();
    if (!key || args.length !== 2) {
      return commandResult({
        stderr: `Usage:\n${usage}\n`,
        exitCode: 2,
      });
    }
    // The Space's rows come first, so its value wins.
    const row = rows.find((entry) => entry.key === key);
    return commandResult({
      stdout: row ? { ok: true, ...row } : { ok: true, key, found: false },
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
    const prefix = prefixResult.prefix;
    return commandResult({
      stdout: {
        ok: true,
        entries: rows
          .filter((entry) => !prefix || entry.key.startsWith(prefix))
          .sort((left, right) => left.key.localeCompare(right.key)),
      },
      exitCode: 0,
    });
  }

  return commandResult({
    stderr: `Usage:\n${usage}\n`,
    exitCode: 2,
  });
}

/** List installed plugin metadata that is useful to agent tool selection. */
async function handlePluginsCommand(
  args: string[],
): Promise<ReturnType<typeof commandResult>> {
  const usage = "jr-rpc plugins list";
  const subverb = (args[0] ?? "").trim();
  if (subverb !== "list" || args.length !== 1) {
    return commandResult({
      stderr: `Usage:\n${usage}\n`,
      exitCode: 2,
    });
  }

  const plugins = getAppContext()
    .catalog.getProviders()
    .map((plugin) => ({
      name: plugin.manifest.name,
      displayName: plugin.manifest.displayName,
      description: plugin.manifest.description,
      configKeys: [...plugin.manifest.configKeys],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return commandResult({
    stdout: {
      ok: true,
      plugins,
    },
    exitCode: 0,
  });
}

async function runJrRpc(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const usage = [
    "jr-rpc config get <key>",
    "jr-rpc config list [--prefix <value>]",
    "jr-rpc plugins list",
  ].join("\n");
  const verb = (args[0] ?? "").trim();
  if (verb === "config") {
    return handleConfigCommand(args.slice(1), deps);
  }
  if (verb === "plugins") {
    return handlePluginsCommand(args.slice(1));
  }
  return commandResult({
    stderr: `Unsupported jr-rpc command. Use:\n${usage}\n`,
    exitCode: 2,
  });
}

type JrRpcToken = parse.ParseEntry | { op: "var"; key: string };

/** Write a token back as command text, for the rejection message. */
function tokenText(token: JrRpcToken): string {
  if (typeof token === "string") return token;
  if ("comment" in token) return `#${token.comment}`;
  if (token.op === "glob") return token.pattern;
  if (token.op === "var") return `$${token.key}`;
  return token.op;
}

/**
 * Find the first part of a jr-rpc command line that a shell would expand or
 * run: `$VAR`, `$(...)`, a backtick, a glob, a comment, or an operator. An
 * operator or comment takes the rest of the line with it, because that rest
 * is the other command or the redirect target.
 */
function findShellPart(
  command: string,
  tokens: JrRpcToken[],
): string | undefined {
  // shell-quote keeps backticks as literal text.
  const backtick = /`[^`]*`?/.exec(command);
  if (backtick) return backtick[0];
  const index = tokens.findIndex((token) => typeof token !== "string");
  const token = tokens[index];
  if (token === undefined || typeof token === "string") return undefined;
  if ("op" in token && (token.op === "var" || token.op === "glob")) {
    // shell-quote splits `$(id)` into an empty variable and `(`, `id`, `)`.
    if (token.op === "var" && !token.key) {
      return /\$\([^)]*\)?/.exec(command)?.[0] ?? "$(";
    }
    return tokenText(token);
  }
  // A file descriptor number before a redirect belongs to it, as in `2>&1`.
  const previous = tokens[index - 1];
  const start =
    index > 1 && typeof previous === "string" && /^\d+$/.test(previous)
      ? index - 1
      : index;
  return tokens
    .slice(start)
    .map(tokenText)
    .join(" ")
    .replace(/^(\d+) ([<>])/, "$1$2")
    .replace(/([<>]&) (\d+)/, "$1$2");
}

function toolCommandResult(
  command: string,
  output: { exitCode: number; stdout: string; stderr: string },
) {
  return {
    ok: output.exitCode === 0,
    command,
    cwd: "/",
    exit_code: output.exitCode,
    signal: null,
    timed_out: false,
    stdout: output.stdout,
    stderr: output.stderr,
    stdout_truncated: false,
    stderr_truncated: false,
  };
}

// `jr-rpc` exists only in this runtime shell, not in the sandbox. A command
// that runs it after another shell step would reach the sandbox and fail with
// "command not found".
const CHAINED_JR_RPC_PATTERN = /(?:&&|\|\||[;|\n])\s*jr-rpc(?:\s|$)/;

/** Run a standalone `jr-rpc` bash command, or reject one chained after other shell steps. */
export async function maybeExecuteJrRpcCustomCommand(
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
  if (!/^jr-rpc(?:\s|$)/.test(normalized)) {
    if (!CHAINED_JR_RPC_PATTERN.test(normalized)) {
      return { handled: false };
    }
    return {
      handled: true,
      result: toolCommandResult(normalized, {
        exitCode: 2,
        stdout: "",
        stderr:
          "jr-rpc runs only as a standalone bash command. Run the jr-rpc command by itself, without cd, &&, pipes, or other commands.\n",
      }),
    };
  }
  // The env function makes `$VAR` and `$(...)` tokens instead of text.
  const tokens: JrRpcToken[] = parse(normalized, (key) => ({
    op: "var",
    key,
  }));
  const shellPart = findShellPart(normalized, tokens);
  if (shellPart !== undefined) {
    return {
      handled: true,
      result: toolCommandResult(normalized, {
        exitCode: 2,
        stdout: "",
        stderr: `jr-rpc takes plain arguments only. Remove "${shellPart}" and run the jr-rpc command again.\n`,
      }),
    };
  }
  const args = tokens.filter((token) => typeof token === "string");
  return {
    handled: true,
    result: toolCommandResult(normalized, await runJrRpc(args.slice(1), deps)),
  };
}
