export const CLI_USAGE =
  "usage: junior init <dir>\n       junior admin list|grant <email>|revoke <email>\n       junior service-account connect|status|disconnect <plugin>\n       junior snapshot create\n       junior check [dir]\n       junior upgrade\n       junior chat\n       junior chat -p <message>\n       junior briefs pull <conversationId...> --base-url <url> [--token <token>] --out <dir>\n       junior briefs run <snapshot...> [--model <id>] [--prompt <file>] [--turn-by-turn] [--out <dir>]\n       junior conversations list --base-url <url> [--token <token>]";

interface CliHandlers {
  runAdmin: (argv: string[]) => Promise<number>;
  runBriefs: (argv: string[]) => Promise<number>;
  runServiceAccount: (argv: string[]) => Promise<number>;
  runChat: (argv: string[]) => Promise<number>;
  runConversations: (argv: string[]) => Promise<number>;
  runInit: (dir: string) => Promise<void>;
  runSnapshotCreate: () => Promise<void>;
  runCheck: (dir?: string) => Promise<void>;
  runUpgrade: () => Promise<void>;
  runPluginCommand?: (
    command: string,
    argv: string[],
  ) => Promise<number | undefined>;
}

interface CliIo {
  error: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  error: console.error,
};

/** Read the value after a command option, or throw when it is missing. */
export function optionValue(
  argv: string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

/** Strip Node's leading argv separator while preserving command-level flags. */
function normalizeCliArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

/** Dispatch CLI arguments to command handlers and return a process exit code. */
export async function runCli(
  argv: string[],
  handlers: CliHandlers,
  io: CliIo = DEFAULT_IO,
): Promise<number> {
  const [command, subcommand, ...rest] = normalizeCliArgv(argv);

  if (command === "chat") {
    return await handlers.runChat(
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
  }

  if (command === "admin") {
    return await handlers.runAdmin(
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
  }

  if (command === "service-account") {
    return await handlers.runServiceAccount(
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
  }

  if (command === "briefs") {
    return await handlers.runBriefs(
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
  }

  if (command === "conversations") {
    return await handlers.runConversations(
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
  }

  if (command === "init") {
    if (!subcommand || rest.length > 0) {
      io.error(CLI_USAGE);
      return 1;
    }
    await handlers.runInit(subcommand);
    return 0;
  }

  if (command === "snapshot" && subcommand === "create") {
    if (rest.length > 0) {
      io.error(CLI_USAGE);
      return 1;
    }
    await handlers.runSnapshotCreate();
    return 0;
  }

  if (command === "check") {
    if (rest.length > 0) {
      io.error(CLI_USAGE);
      return 1;
    }
    await handlers.runCheck(subcommand);
    return 0;
  }

  if (command === "upgrade") {
    if (subcommand || rest.length > 0) {
      io.error(CLI_USAGE);
      return 1;
    }
    await handlers.runUpgrade();
    return 0;
  }

  if (command && handlers.runPluginCommand) {
    const exitCode = await handlers.runPluginCommand(
      command,
      subcommand === undefined ? [] : [subcommand, ...rest],
    );
    if (exitCode !== undefined) {
      return exitCode;
    }
  }

  io.error(CLI_USAGE);
  return 1;
}
