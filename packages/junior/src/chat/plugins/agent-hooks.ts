import type {
  AgentPluginRequester,
  AgentPluginSandbox,
  JuniorPlugin,
} from "@sentry/junior-plugin-api";
import { logInfo } from "@/chat/logging";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type {
  SandboxCommandInput,
  SandboxInstance,
} from "@/chat/sandbox/workspace";

/** Signal that a trusted plugin intentionally denied a tool execution. */
export class AgentPluginHookDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPluginHookDeniedError";
  }
}

export interface ToolHookInput {
  input: Record<string, unknown>;
  name: string;
}

export interface ToolHookResult {
  env: Record<string, string>;
  input: Record<string, unknown>;
}

export interface AgentPluginHookRunner {
  beforeToolExecute(input: ToolHookInput): Promise<ToolHookResult>;
  prepareSandbox(sandbox: SandboxInstance): Promise<void>;
}

let agentPlugins: JuniorPlugin[] = [];
const AGENT_PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Validate trusted plugin identity before it can affect process-wide hooks. */
export function validateAgentPlugins(plugins: JuniorPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!AGENT_PLUGIN_NAME_RE.test(plugin.name)) {
      throw new Error(
        `Trusted plugin name "${plugin.name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(plugin.name)) {
      throw new Error(`Duplicate trusted plugin name "${plugin.name}"`);
    }
    seen.add(plugin.name);
  }
}

/** Replace trusted agent plugins and return the previous list for rollback. */
export function setAgentPlugins(plugins: JuniorPlugin[]): JuniorPlugin[] {
  validateAgentPlugins(plugins);
  const previous = agentPlugins;
  agentPlugins = [...plugins].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return previous;
}

/** Return the current trusted agent plugins without exposing mutable state. */
export function getAgentPlugins(): JuniorPlugin[] {
  return [...agentPlugins];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    }
  }
  return env;
}

function createSandboxCapability(sandbox: SandboxInstance): AgentPluginSandbox {
  return {
    root: SANDBOX_WORKSPACE_ROOT,
    juniorRoot: `${SANDBOX_WORKSPACE_ROOT}/.junior`,
    async readFile(filePath) {
      return (await sandbox.readFileToBuffer({ path: filePath })) ?? null;
    },
    async run(input: SandboxCommandInput) {
      const result = await sandbox.runCommand(input);
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
      };
    },
    async writeFile(input) {
      await sandbox.writeFiles([
        {
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        },
      ]);
    },
  };
}

/** Create one runner over trusted agent plugins registered by the app. */
export function createAgentPluginHookRunner(
  input: {
    requester?: AgentPluginRequester;
  } = {},
): AgentPluginHookRunner {
  const loaded = getAgentPlugins();

  return {
    async prepareSandbox(sandbox) {
      const sandboxCapability = createSandboxCapability(sandbox);
      for (const plugin of loaded) {
        const hook = plugin.hooks?.sandboxPrepare;
        if (!hook) {
          continue;
        }
        logInfo(
          "agent_plugin_hook_sandbox_prepare",
          {},
          { "app.plugin.name": plugin.name },
          "Running agent plugin sandbox prepare hook",
        );
        await hook({
          plugin: { name: plugin.name },
          requester: input.requester,
          sandbox: sandboxCapability,
        });
      }
    },
    async beforeToolExecute(tool) {
      let nextInput = { ...tool.input };
      const env = normalizeEnv(nextInput.env);

      for (const plugin of loaded) {
        const hook = plugin.hooks?.beforeToolExecute;
        if (!hook) {
          continue;
        }
        let replacement: Record<string, unknown> | undefined;
        let denied: string | undefined;
        await hook({
          plugin: { name: plugin.name },
          requester: input.requester,
          tool: {
            name: tool.name,
            input: nextInput,
          },
          env: {
            get(key) {
              return env[key];
            },
            set(key, value) {
              env[key] = value;
            },
          },
          decision: {
            deny(message) {
              denied = message;
            },
            replaceInput(input) {
              replacement = input;
            },
          },
        });

        if (denied) {
          throw new AgentPluginHookDeniedError(denied);
        }
        if (replacement !== undefined) {
          if (!isRecord(replacement)) {
            throw new Error(
              `Plugin "${plugin.name}" replaced tool input with a non-object value`,
            );
          }
          nextInput = { ...replacement };
          Object.assign(env, normalizeEnv(nextInput.env));
        }
      }

      return {
        input: {
          ...nextInput,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
        env,
      };
    },
  };
}
