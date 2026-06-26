import { stderr as defaultStderr, stdout as defaultStdout } from "node:process";
import { createJiti } from "jiti";
import type {
  PluginCliCommandDefinition,
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

      const pluginName = resolved.plugin.manifest.name;
      const result = await resolved.command.run({
        argv,
        db: getDb(),
        io,
        log: createPluginLogger(pluginName),
        plugin: { name: pluginName },
      });
      return result ?? 0;
    },
  };
}
