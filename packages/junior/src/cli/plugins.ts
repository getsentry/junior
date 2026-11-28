/**
 * Plugin CLI bootstrap for the local/package command line.
 * This module imports app plugins, validates them and their top-level
 * namespaces, and dispatches only plugin-owned subcommands.
 */
import { stderr as defaultStderr, stdout as defaultStdout } from "node:process";
import { createJiti } from "jiti";
import { Command, CommanderError } from "commander";
import type {
  PluginCliCommandDefinition,
  PluginCliHost,
  PluginCliIo,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { createPluginLogger } from "@/chat/plugins/logging";
import { coreRegistrations } from "@/chat/plugins/core-registrations";
import { validatePlugins } from "@/chat/plugins/hooks/registry";
import { createPluginCatalogRuntime } from "@/chat/plugins/registry";
import {
  validatePluginEgressCredentialHooks,
  validatePluginRegistrations,
} from "@/chat/plugins/validation";
import { loadAppPluginSet } from "@/plugin-module";
import {
  pluginCliRegistrationsFromPluginSet,
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "@/plugins";
import { withCliAppContext } from "./context";

export type PluginCommandIo = PluginCliIo;

const pluginCliLoader = createJiti(import.meta.url, { moduleCache: false });
const CORE_COMMAND_NAMES = new Set([
  "admin",
  "chat",
  "check",
  "init",
  "snapshot",
  "upgrade",
]);
const PLUGIN_COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

const DEFAULT_IO: PluginCommandIo = {
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

/** Load the app plugin set once for one CLI process. */
export async function loadCliPluginSet(): Promise<JuniorPluginSet | undefined> {
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
  pluginSet: JuniorPluginSet | undefined;
  setExitCode: (exitCode: number) => void;
}): PluginCliHost {
  return {
    action(handler) {
      return async (...actionArgs) => {
        const pluginName = args.plugin.manifest.name;
        const result = await withCliAppContext(
          { pluginSet: args.pluginSet },
          async (context) =>
            await handler(
              {
                db: context.sql.db(),
                command: {
                  name: args.command.name,
                  summary: args.command.summary,
                },
                io: args.io,
                log: createPluginLogger(pluginName),
                plugin: { name: pluginName },
              },
              ...actionArgs,
            ),
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
  pluginSet: JuniorPluginSet | undefined;
  setExitCode: (exitCode: number) => void;
}): Command {
  const command = new Command(args.command.name)
    .description(args.command.summary)
    .exitOverride()
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => {
        void args.io.writeOutput(text);
      },
      writeErr: (text) => {
        void args.io.writeError(text);
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
  plugin: PluginRegistration;
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
  if (args.command.aliases().length > 0) {
    throw new Error(
      `Plugin CLI command "${args.definition.name}" from plugin "${pluginName}" must not define top-level aliases`,
    );
  }
}

function validateConfiguredPluginCommands(plugins: PluginRegistration[]): void {
  const ownerByName = new Map<string, string>();
  const validationIo = DEFAULT_IO;
  for (const plugin of plugins) {
    for (const definition of plugin.cli?.commands ?? []) {
      const pluginName = plugin.manifest.name;
      const existingOwner = ownerByName.get(definition.name);
      if (!PLUGIN_COMMAND_NAME_RE.test(definition.name)) {
        throw new Error(
          `Plugin CLI command "${definition.name}" from plugin "${pluginName}" must be a lowercase command identifier`,
        );
      }
      if (CORE_COMMAND_NAMES.has(definition.name)) {
        throw new Error(
          `Plugin CLI command "${definition.name}" from plugin "${pluginName}" conflicts with a core command`,
        );
      }
      if (existingOwner) {
        throw new Error(
          `Plugin CLI command "${definition.name}" from plugin "${pluginName}" conflicts with plugin "${existingOwner}"`,
        );
      }
      ownerByName.set(definition.name, pluginName);
      if (typeof definition.configure !== "function") {
        throw new Error(
          `Plugin CLI command "${definition.name}" from plugin "${pluginName}" must define a configure function`,
        );
      }
      let exitCode = 0;
      validateConfiguredPluginCommand({
        command: createPluginCommanderCommand({
          command: definition,
          io: validationIo,
          plugin,
          pluginSet: undefined,
          setExitCode: (nextExitCode) => {
            exitCode = nextExitCode;
          },
        }),
        definition,
        plugin,
      });
      void exitCode;
    }
  }
}

// Validate the plugin set against its own catalog. Each command builds its
// app context when it runs, so loading commands needs no config.
function loadCliPlugins(args: {
  pluginSet?: JuniorPluginSet | undefined;
  validateConfiguredCommands?: (plugins: PluginRegistration[]) => void;
}): PluginRegistration[] {
  const pluginSet = args.pluginSet;
  const coreCliPlugins = coreRegistrations().filter((plugin) => plugin.cli);
  if (!pluginSet) {
    return coreCliPlugins;
  }

  const cliPlugins = [
    ...pluginCliRegistrationsFromPluginSet(pluginSet),
    ...coreCliPlugins,
  ];
  validatePlugins(pluginRuntimeRegistrationsFromPluginSet(pluginSet));
  const catalog = createPluginCatalogRuntime();
  catalog.setConfig(pluginCatalogConfigFromPluginSet(pluginSet));
  validatePluginRegistrations(catalog, pluginSet.registrations);
  validatePluginEgressCredentialHooks(catalog, pluginSet.registrations);
  args.validateConfiguredCommands?.(cliPlugins);
  return cliPlugins;
}

/** Import configured app plugins and build the plugin CLI command dispatcher. */
export async function loadCliPluginCommands(
  pluginSet?: JuniorPluginSet | null,
): Promise<CliPluginCommandDispatcher> {
  const resolvedPluginSet =
    pluginSet === undefined
      ? await loadCliPluginSet()
      : (pluginSet ?? undefined);
  const cliPlugins = loadCliPlugins({
    pluginSet: resolvedPluginSet,
    validateConfiguredCommands: validateConfiguredPluginCommands,
  });
  const commandNames = cliPlugins.flatMap((plugin) =>
    (plugin.cli?.commands ?? []).map((command) => command.name),
  );

  return {
    commandNames,
    async run(commandName, argv, io = DEFAULT_IO) {
      const resolved = findPluginCommand(cliPlugins, commandName);
      if (!resolved) {
        return undefined;
      }

      let exitCode = 0;
      const command = createPluginCommanderCommand({
        command: resolved.command,
        io,
        plugin: resolved.plugin,
        pluginSet: resolvedPluginSet,
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
