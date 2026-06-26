import type { Command } from "commander";
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

/** Host/admin context exposed to plugin-owned CLI command actions. */
export interface PluginCliActionContext extends PluginContext {
  io: PluginCliIo;
}

export type PluginCliActionHandler<Args extends unknown[] = unknown[]> = (
  ctx: PluginCliActionContext,
  ...args: Args
) => Promise<number | void> | number | void;

export interface PluginCliHost {
  action<Args extends unknown[]>(
    handler: PluginCliActionHandler<Args>,
  ): (...args: Args) => Promise<void>;
}

/** Plugin-owned top-level CLI command registration. */
export interface PluginCliCommandDefinition {
  configure(command: Command, junior: PluginCliHost): void;
  name: string;
  summary: string;
}

/** Plugin-owned CLI command catalog. */
export interface PluginCliDefinition {
  commands: PluginCliCommandDefinition[];
}
