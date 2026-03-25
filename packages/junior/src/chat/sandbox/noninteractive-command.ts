interface NonInteractiveShellOptions {
  env?: Record<string, string>;
  pathPrefix?: string;
}

interface NonInteractiveCommandInput extends NonInteractiveShellOptions {
  args?: string[];
  cmd: string;
  cwd?: string;
  login?: boolean;
  sudo?: boolean;
}

interface CommandRunner {
  runCommand(input: any): Promise<{
    exitCode: number;
    stderr(): Promise<string>;
    stdout(): Promise<string>;
  }>;
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
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildEnvExports(options: NonInteractiveShellOptions): string[] {
  const lines: string[] = [];
  if (options.pathPrefix) {
    lines.push(`export PATH="${options.pathPrefix}"`);
  }

  for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }

  return lines;
}

function toCommandScript(input: NonInteractiveCommandInput): string {
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
      buildNonInteractiveShellScript(toCommandScript(input), {
        env: input.env,
        pathPrefix: input.pathPrefix,
      }),
    ],
  };
}

/** Run a subprocess through one enforced non-interactive entrypoint. */
export async function runNonInteractiveCommand(
  runner: CommandRunner,
  input: NonInteractiveCommandInput,
): Promise<{
  exitCode: number;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
}> {
  return await runner.runCommand({
    ...buildNonInteractiveCommand(input),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sudo !== undefined ? { sudo: input.sudo } : {}),
  });
}
