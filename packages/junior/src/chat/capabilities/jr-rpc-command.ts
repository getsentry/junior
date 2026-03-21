import { Bash, defineCommand } from "just-bash";
import { listCapabilityProviders } from "@/chat/capabilities/catalog";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { parseRepoTarget } from "@/chat/capabilities/target";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { logInfo } from "@/chat/observability";
import {
  getPluginOAuthConfig,
  isPluginProvider,
} from "@/chat/plugins/registry";
import type { Skill } from "@/chat/skills";

type JrRpcDeps = {
  capabilityRuntime: SkillCapabilityRuntime;
  activeSkill: Skill | null;
  channelConfiguration?: ChannelConfigurationService;
  requesterId?: string;
  channelId?: string;
  threadTs?: string;
  userMessage?: string;
  userTokenStore?: UserTokenStore;
  onConfigurationValueChanged?: (
    key: string,
    value: unknown | undefined,
  ) => void;
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

async function handleIssueCredentialCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const capability = (args[0] ?? "").trim();
  if (!capability) {
    return commandResult({
      stderr: "jr-rpc issue-credential requires a capability argument\n",
      exitCode: 2,
    });
  }

  let repoRef: string | undefined;
  const extras = args.slice(1);
  if (extras.length > 0) {
    if (extras.length === 2 && extras[0] === "--repo") {
      repoRef = extras[1];
    } else if (extras.length === 1 && extras[0].startsWith("--repo=")) {
      repoRef = extras[0].slice("--repo=".length);
    } else {
      return {
        stdout: "",
        stderr:
          "jr-rpc issue-credential requires exactly one capability argument and optional --repo <owner/repo>\n",
        exitCode: 2,
      };
    }
    if (!parseRepoTarget(repoRef ?? "")) {
      return {
        stdout: "",
        stderr: "jr-rpc issue-credential --repo must be in owner/repo format\n",
        exitCode: 2,
      };
    }
  }

  let outcome: { reused: boolean; expiresAt: string };
  try {
    outcome = await deps.capabilityRuntime.enableCapabilityForTurn({
      activeSkill: deps.activeSkill,
      capability,
      ...(repoRef ? { repoRef } : {}),
      reason: `skill:${deps.activeSkill?.name ?? "unknown"}:jr-rpc:issue-credential`,
    });
  } catch (error) {
    // Auto-start OAuth when no credentials are available for an OAuth-capable provider
    if (
      error instanceof CredentialUnavailableError &&
      getPluginOAuthConfig(error.provider) &&
      deps.requesterId
    ) {
      const oauthResult = await startOAuthFlow(error.provider, {
        requesterId: deps.requesterId,
        channelId: deps.channelId,
        threadTs: deps.threadTs,
        userMessage: deps.userMessage,
        channelConfiguration: deps.channelConfiguration,
        activeSkillName: deps.activeSkill?.name ?? undefined,
      });
      if (oauthResult.ok) {
        const providerLabel = formatProviderLabel(error.provider);
        return commandResult({
          stdout: {
            credential_unavailable: true,
            oauth_started: true,
            provider: error.provider,
            private_delivery_sent: !!oauthResult.delivery,
            message: oauthResult.delivery
              ? `I need to connect your ${providerLabel} account first. I've sent you a private authorization link.`
              : `I need to connect your ${providerLabel} account first, but I wasn't able to send you a private authorization link. Please send me a direct message and try your command again.`,
          },
          exitCode: 0,
        });
      }
      // OAuth start failed — surface the specific misconfiguration error
      return {
        stdout: "",
        stderr: `${oauthResult.error}\n`,
        exitCode: 1,
      };
    }

    return {
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      exitCode: 1,
    };
  }

  return commandResult({
    stdout: `${outcome.reused ? "credential_reused" : "credential_enabled"} capability=${capability} expiresAt=${outcome.expiresAt}\n`,
    exitCode: 0,
  });
}

async function handleConfigCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const usage = [
    "jr-rpc config get <key>",
    "jr-rpc config set <key> <value> [--json]",
    "jr-rpc config unset <key>",
    "jr-rpc config list [--prefix <value>]",
  ].join("\n");
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
        stderr: `Usage:\n${usage}\n`,
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
        stderr: `Usage:\n${usage}\n`,
        exitCode: 2,
      });
    }

    let parseAsJson = false;
    if (extras.length > 0) {
      if (extras.length === 1 && extras[0] === "--json") {
        parseAsJson = true;
      } else {
        return commandResult({
          stderr: `Usage:\n${usage}\n`,
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
        stderr: `Usage:\n${usage}\n`,
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
    const entries = await configuration.list({
      ...(prefixResult.prefix ? { prefix: prefixResult.prefix } : {}),
    });
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
    stderr: `Usage:\n${usage}\n`,
    exitCode: 2,
  });
}

function isKnownProvider(provider: string): boolean {
  return (
    listCapabilityProviders().some((p) => p.provider === provider) ||
    isPluginProvider(provider)
  );
}

async function handleOAuthStartCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const provider = (args[0] ?? "").trim();
  if (!provider) {
    return commandResult({
      stderr: "jr-rpc oauth-start requires: <provider>\n",
      exitCode: 2,
    });
  }

  if (args.length > 1) {
    return commandResult({
      stderr: "jr-rpc oauth-start accepts only a provider argument\n",
      exitCode: 2,
    });
  }

  // Check if user already has valid tokens for this provider
  if (deps.requesterId && deps.userTokenStore) {
    const stored = await deps.userTokenStore.get(deps.requesterId, provider);
    if (
      stored &&
      (stored.expiresAt === undefined || stored.expiresAt > Date.now())
    ) {
      const providerLabel = formatProviderLabel(provider);
      return commandResult({
        stdout: {
          ok: true,
          already_connected: true,
          provider,
          message: `Your ${providerLabel} account is already connected.`,
        },
        exitCode: 0,
      });
    }
  }

  if (!deps.requesterId) {
    return commandResult({
      stderr: "jr-rpc oauth-start requires requester context (requesterId)\n",
      exitCode: 1,
    });
  }

  // Explicit oauth-start must not store pendingMessage — the auth request
  // itself is the intent, and auto-resuming an explicit reconnect request would loop.
  const result = await startOAuthFlow(provider, {
    requesterId: deps.requesterId,
    channelId: deps.channelId,
    threadTs: deps.threadTs,
    activeSkillName: deps.activeSkill?.name ?? undefined,
  });
  if (!result.ok) {
    return commandResult({ stderr: `${result.error}\n`, exitCode: 1 });
  }

  if (!result.delivery) {
    return commandResult({
      stdout: {
        ok: true,
        private_delivery_sent: false,
        message:
          "I wasn't able to send you a private authorization link. Please send me a direct message and try again.",
      },
      exitCode: 0,
    });
  }

  return commandResult({
    stdout: {
      ok: true,
      private_delivery_sent: true,
    },
    exitCode: 0,
  });
}

async function handleDeleteTokenCommand(
  args: string[],
  deps: JrRpcDeps,
): Promise<ReturnType<typeof commandResult>> {
  const provider = (args[0] ?? "").trim();
  if (!provider) {
    return commandResult({
      stderr: "jr-rpc delete-token requires: <provider>\n",
      exitCode: 2,
    });
  }
  if (!isKnownProvider(provider)) {
    return commandResult({
      stderr: `Unknown provider: ${provider}\n`,
      exitCode: 2,
    });
  }
  if (!deps.requesterId) {
    return commandResult({
      stderr: "jr-rpc delete-token requires requester context (requesterId)\n",
      exitCode: 1,
    });
  }
  if (!deps.userTokenStore) {
    return commandResult({
      stderr: "Token storage is not available\n",
      exitCode: 1,
    });
  }

  await unlinkProvider(deps.requesterId, provider, deps.userTokenStore);

  logInfo(
    "jr_rpc_delete_token",
    {},
    {
      "app.credential.provider": provider,
      ...(deps.activeSkill?.name
        ? { "app.skill.name": deps.activeSkill.name }
        : {}),
    },
    "Deleted user token via jr-rpc",
  );

  return commandResult({
    stdout: `token_deleted provider=${provider}\n`,
    exitCode: 0,
  });
}

function createJrRpcCommand(deps: JrRpcDeps) {
  return defineCommand("jr-rpc", async (args) => {
    const usage = [
      "jr-rpc issue-credential <capability> [--repo <owner/repo>]",
      "jr-rpc oauth-start <provider>",
      "jr-rpc delete-token <provider>",
      "jr-rpc config get <key>",
      "jr-rpc config set <key> <value> [--json]",
      "jr-rpc config unset <key>",
      "jr-rpc config list [--prefix <value>]",
    ].join("\n");
    const verb = (args[0] ?? "").trim();
    if (verb === "issue-credential") {
      return handleIssueCredentialCommand(args.slice(1), deps);
    }
    if (verb === "oauth-start") {
      return handleOAuthStartCommand(args.slice(1), deps);
    }
    if (verb === "delete-token") {
      return handleDeleteTokenCommand(args.slice(1), deps);
    }
    if (verb === "config") {
      return handleConfigCommand(args.slice(1), deps);
    }
    return commandResult({
      stderr: `Unsupported jr-rpc command. Use:\n${usage}\n`,
      exitCode: 2,
    });
  });
}

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
    return { handled: false };
  }
  const shell = new Bash({
    customCommands: [createJrRpcCommand(deps)],
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
      stderr_truncated: false,
    },
  };
}
