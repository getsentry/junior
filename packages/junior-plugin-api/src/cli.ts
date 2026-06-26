import type { PluginContext } from "./context";

export interface PluginCliWriteStream {
  write(
    text: string,
    callback?: (error?: Error | null | undefined) => void,
  ): unknown;
}

export interface PluginCliIo {
  stderr: PluginCliWriteStream;
  stdout: PluginCliWriteStream;
  writeError(text: string): Promise<void> | void;
  writeOutput(text: string): Promise<void> | void;
}

/** Host/admin context exposed to plugin-owned CLI command handlers. */
export interface PluginCliCommandContext extends PluginContext {
  argv: string[];
  io: PluginCliIo;
}

/** Plugin-owned top-level CLI command registration. */
export interface PluginCliCommandDefinition {
  name: string;
  run(ctx: PluginCliCommandContext): Promise<number | void> | number | void;
  summary: string;
  usage?: string;
}

/** Plugin-owned CLI command catalog. */
export interface PluginCliDefinition {
  commands: PluginCliCommandDefinition[];
}
