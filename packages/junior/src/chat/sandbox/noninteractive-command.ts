import type {
  SandboxCommandInput,
  SandboxCommandResult,
  SandboxWorkspace,
} from "@/chat/sandbox/workspace";

interface NonInteractiveShellOptions {
  env?: Record<string, string>;
  /** Full PATH value to export, for example `$PATH:/extra/bin`. */
  path?: string;
}

interface NonInteractiveCommandInput extends NonInteractiveShellOptions {
  args?: string[];
  cmd: string;
  cwd?: string;
  login?: boolean;
  signal?: AbortSignal;
  sudo?: boolean;
  timeoutMs?: number;
}

const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  TERM: "dumb",
  NO_COLOR: "1",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  DEBIAN_FRONTEND: "noninteractive",
  // Git credential isolation: prevent git from sending its own auth so the
  // sandbox egress proxy's header transforms are the sole credential source.
  GIT_ASKPASS: "/bin/true",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Git config the runtime always applies through `GIT_CONFIG_COUNT`. */
const RUNTIME_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["credential.helper", ""],
  ["http.emptyAuth", "true"],
];

/**
 * Combine command Git config env entries with the runtime entries.
 *
 * Plugin hooks can add Git config with `GIT_CONFIG_COUNT`. Their entries keep
 * their order, and the runtime entries come last so credential isolation
 * always wins.
 */
function gitConfigEnv(env: Record<string, string>): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < count; index++) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    if (key) {
      entries.push([key, env[`GIT_CONFIG_VALUE_${index}`] ?? ""]);
    }
  }
  entries.push(...RUNTIME_GIT_CONFIG);

  const result: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildEnvExports(options: NonInteractiveShellOptions): string[] {
  const lines: string[] = [];
  if (options.path) {
    lines.push(`export PATH="${options.path}"`);
  }

  const env = {
    ...NON_INTERACTIVE_ENV,
    ...options.env,
    ...gitConfigEnv(options.env ?? {}),
  };
  for (const [key, value] of Object.entries(env)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  return lines;
}

/** Render one argv command as a safely quoted shell script. */
export function buildCommandScript(
  input: Pick<NonInteractiveCommandInput, "args" | "cmd">,
): string {
  return [shellQuote(input.cmd), ...(input.args ?? []).map(shellQuote)].join(
    " ",
  );
}

/** Build one shell entrypoint that never waits on terminal input. */
export function buildNonInteractiveShellScript(
  script: string,
  options: NonInteractiveShellOptions = {},
): string {
  return [...buildEnvExports(options), "exec </dev/null", script].join(" && ");
}

/** Wrap argv-style commands so every sandbox subprocess runs in non-interactive mode. */
function buildNonInteractiveCommand(input: NonInteractiveCommandInput): {
  args: string[];
  cmd: "bash";
} {
  return {
    cmd: "bash",
    args: [
      input.login ? "-lc" : "-c",
      buildNonInteractiveShellScript(buildCommandScript(input), {
        env: input.env,
        path: input.path,
      }),
    ],
  };
}

/** Run a subprocess through one enforced non-interactive entrypoint. */
export async function runNonInteractiveCommand(
  sandbox: Pick<SandboxWorkspace, "runCommand">,
  input: NonInteractiveCommandInput,
): Promise<SandboxCommandResult> {
  const command: SandboxCommandInput = {
    ...buildNonInteractiveCommand(input),
    ...(input.cwd ? { cwd: input.cwd } : undefined),
    ...(input.signal ? { signal: input.signal } : undefined),
    ...(input.sudo !== undefined ? { sudo: input.sudo } : undefined),
    ...(input.timeoutMs !== undefined
      ? { timeoutMs: input.timeoutMs }
      : undefined),
  };
  return await sandbox.runCommand(command);
}
