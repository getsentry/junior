import { stderr as defaultStderr, stdout as defaultStdout } from "node:process";
import { createJiti } from "jiti";
import { Command, CommanderError } from "commander";
import type {
  PluginCliCommandDefinition,
  PluginCliHost,
  PluginCliIo,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import { setPlugins, validatePlugins } from "@/chat/plugins/agent-hooks";
import {
  validatePluginEgressCredentialHooks,
  validatePluginRegistrations,
} from "@/chat/plugins/validation";
import { loadAppPluginSet } from "@/plugin-module";
import {
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";

export type PluginCommandIo = PluginCliIo;

const pluginCliLoader = createJiti(import.meta.url, { moduleCache: false });

const DEFAULT_IO: PluginCommandIo = {
  stderr: defaultStderr,
  stdout: defaultStdout,
  writeError: (text) => writeStream(defaultStderr, text),
  writeOutput: (text) => writeStream(defaultStdout, text),
};

export interface CliPluginCommandDispatcher {
  commandNames: string[];
  run(
    commandName: string,
    argv: string[],
    io?: PluginCommandIo,
  ): Promise<number | undefined>;
}

function writeStream(
  stream: NodeJS.WritableStream,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function loadPluginSet(): Promise<JuniorPluginSet | undefined> {
  return await loadAppPluginSet(process.cwd(), async (moduleRef) =>
    pluginCliLoader.import<Record<string, unknown>>(moduleRef.importPath),
  );
}

function findPluginCommand(
  plugins: PluginRegistration[],
  commandName: string,
):
  | { command: PluginCliCommandDefinition; plugin: PluginRegistration }
  | undefined {
  for (const plugin of plugins) {
    const command = plugin.cli?.commands.find(
      (candidate) => candidate.name === commandName,
    );
    if (command) {
      return { command, plugin };
    }
  }
  return undefined;
}

function createPluginCliHost(args: {
  command: PluginCliCommandDefinition;
  io: PluginCommandIo;
  plugin: PluginRegistration;
  setExitCode: (exitCode: number) => void;
}): PluginCliHost {
  return {
    action(handler) {
      return async (...actionArgs) => {
        const pluginName = args.plugin.manifest.name;
        const result = await handler(
          {
            db: getDb(),
            io: args.io,
            log: createPluginLogger(pluginName),
            plugin: { name: pluginName },
          },
          ...actionArgs,
        );
        args.setExitCode(result ?? 0);
      };
    },
  };
}

function createPluginCommanderCommand(args: {
  command: PluginCliCommandDefinition;
  io: PluginCommandIo;
  plugin: PluginRegistration;
  setExitCode: (exitCode: number) => void;
}): Command {
  const command = new Command(args.command.name)
    .description(args.command.summary)
    .exitOverride()
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => {
        args.io.stdout.write(text);
      },
      writeErr: (text) => {
        args.io.stderr.write(text);
      },
      outputError: (text, write) => {
        write(text);
      },
    });

  args.command.configure(command, createPluginCliHost(args));
  return command;
}

function validateConfiguredPluginCommand(args: {
  command: Command;
  definition: PluginCliCommandDefinition;
  ownerByName: Map<string, string>;
  plugin: PluginRegistration;
  seenAliases: Map<string, string>;
}): void {
  const pluginName = args.plugin.manifest.name;
  if (args.command.name() !== args.definition.name) {
    throw new Error(
      `Plugin CLI command "${args.definition.name}" from plugin "${pluginName}" must not rename its top-level command`,
    );
  }
  if (args.command.commands.length === 0) {
    throw new Error(
      `Plugin CLI command "${args.definition.name}" from plugin "${pluginName}" must define at least one subcommand`,
    );
  }
  for (const alias of args.command.aliases()) {
    const existingOwner = args.ownerByName.get(alias);
    if (existingOwner) {
      throw new Error(
        `Plugin CLI command alias "${alias}" from plugin "${pluginName}" conflicts with ${existingOwner}`,
      );
    }
    const aliasOwner = args.seenAliases.get(alias);
    if (aliasOwner) {
      throw new Error(
        `Plugin CLI command alias "${alias}" from plugin "${pluginName}" conflicts with plugin "${aliasOwner}"`,
      );
    }
    args.seenAliases.set(alias, pluginName);
  }
}

function validateConfiguredPluginCommands(plugins: PluginRegistration[]): void {
  const ownerByName = new Map<string, string>();
  for (const plugin of plugins) {
    for (const command of plugin.cli?.commands ?? []) {
      ownerByName.set(command.name, `plugin "${plugin.manifest.name}"`);
    }
  }
  for (const coreCommand of ["chat", "check", "init", "snapshot", "upgrade"]) {
    ownerByName.set(coreCommand, "a core command");
  }

  const seenAliases = new Map<string, string>();
  const validationIo = DEFAULT_IO;
  for (const plugin of plugins) {
    for (const definition of plugin.cli?.commands ?? []) {
      let exitCode = 0;
      validateConfiguredPluginCommand({
        command: createPluginCommanderCommand({
          command: definition,
          io: validationIo,
          plugin,
          setExitCode: (nextExitCode) => {
            exitCode = nextExitCode;
          },
        }),
        definition,
        ownerByName,
        plugin,
        seenAliases,
      });
      void exitCode;
    }
  }
}

async function loadRuntimePlugins(): Promise<PluginRegistration[]> {
  const pluginSet = await loadPluginSet();
  if (!pluginSet) {
    return [];
  }

  const plugins = pluginRuntimeRegistrationsFromPluginSet(pluginSet);
  const pluginConfig = pluginCatalogConfigFromPluginSet(pluginSet);
  validatePlugins(plugins);
  const previousPluginCatalogConfig = setPluginCatalogConfig(pluginConfig);
  try {
    validatePluginRegistrations(pluginSet.registrations);
    validatePluginEgressCredentialHooks(pluginSet.registrations);
    setPlugins(plugins);
    return plugins;
  } catch (error) {
    setPluginCatalogConfig(previousPluginCatalogConfig);
    throw error;
  }
}

/** Import configured app plugins and build the plugin CLI command dispatcher. */
export async function loadCliPluginCommands(): Promise<CliPluginCommandDispatcher> {
  const plugins = await loadRuntimePlugins();
  validateConfiguredPluginCommands(plugins);
  const commandNames = plugins.flatMap((plugin) =>
    (plugin.cli?.commands ?? []).map((command) => command.name),
  );

  return {
    commandNames,
    async run(commandName, argv, io = DEFAULT_IO) {
      const resolved = findPluginCommand(plugins, commandName);
      if (!resolved) {
        return undefined;
      }

      let exitCode = 0;
      const command = createPluginCommanderCommand({
        command: resolved.command,
        io,
        plugin: resolved.plugin,
        setExitCode: (nextExitCode) => {
          exitCode = nextExitCode;
        },
      });
      try {
        await command.parseAsync(argv, { from: "user" });
      } catch (error) {
        if (error instanceof CommanderError) {
          return error.exitCode;
        }
        throw error;
      }
      return exitCode;
    },
  };
}
