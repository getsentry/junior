import type { PluginCommandProxy } from "@/chat/plugins/types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandMentionsProxy(command: string, proxyCommand: string): boolean {
  return new RegExp(
    `(^|[\\s;&|()])${escapeRegExp(proxyCommand.toLowerCase())}($|[\\s;&|()])`,
  ).test(command.toLowerCase());
}

/** Return command-proxy providers mentioned by a bash command string. */
export function getCommandProxyProvidersForCommand(
  command: string,
  commandProxies: PluginCommandProxy[],
): string[] {
  if (!command.trim()) {
    return [];
  }

  return [
    ...new Set(
      commandProxies
        .filter((proxy) => commandMentionsProxy(command, proxy.command))
        .map((proxy) => proxy.provider),
    ),
  ];
}
