export const CLI_USAGE = "usage: junior init <dir>\n       junior snapshot create\n       junior check [dir]";

interface CliHandlers {
  runInit: (dir: string) => Promise<void>;
  runSnapshotCreate: () => Promise<void>;
  runCheck: (dir?: string) => Promise<void>;
}

interface CliIo {
  error: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  error: console.error
};

export async function runCli(argv: string[], handlers: CliHandlers, io: CliIo = DEFAULT_IO): Promise<number> {
  const [command, subcommand, ...rest] = argv;

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

  io.error(CLI_USAGE);
  return 1;
}
