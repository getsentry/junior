/**
 * Public Commander-based CLI contract for plugin-owned admin commands.
 * Junior owns the root command, plugin namespaces, context injection, and exit
 * normalization; plugins only configure subcommands under their namespace.
 */
import type { Command } from "commander";
import type { PluginContext } from "./context";

export interface PluginCliIo {
  writeError(text: string): Promise<void> | void;
  writeOutput(text: string): Promise<void> | void;
}

export interface PluginCliActionCommand {
  name: string;
  summary: string;
}

/** Host/admin context exposed to plugin-owned CLI command actions. */
export interface PluginCliActionContext extends Pick<
  PluginContext,
  "db" | "log" | "plugin"
> {
  command: PluginCliActionCommand;
  io: PluginCliIo;
}

/** Plugin action callback wrapped by the Junior host for context and exit codes. */
export type PluginCliActionHandler<Args extends unknown[] = unknown[]> = (
  ctx: PluginCliActionContext,
  ...args: Args
) => Promise<number | void> | number | void;

export interface PluginCliHost {
  /** Wrap a Commander action so Junior can inject context and normalize exits. */
  action<Args extends unknown[]>(
    handler: PluginCliActionHandler<Args>,
  ): (...args: Args) => Promise<void>;
}

/** Plugin-owned top-level CLI command registration. */
export interface PluginCliCommandDefinition {
  /** Configure subcommands under the host-created top-level namespace. */
  configure(command: Command, junior: PluginCliHost): void;
  /** Unique host-level command namespace owned by this plugin. */
  name: string;
  /** One-line summary used in generated command help. */
  summary: string;
}

/** Plugin-owned CLI command catalog. */
export interface PluginCliDefinition {
  commands: PluginCliCommandDefinition[];
}
