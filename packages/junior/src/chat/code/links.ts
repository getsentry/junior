import { getPlugins } from "@/chat/plugins/agent-hooks";

function codeLinks(provider: string) {
  return getPlugins().find((plugin) => plugin.manifest.name === provider)
    ?.codeLinks;
}

/** Providers whose installed plugin builds code links. */
export function linkedCodeProviders(): string[] {
  return getPlugins().flatMap((plugin) =>
    plugin.codeLinks ? [plugin.manifest.name] : [],
  );
}

/**
 * Build the web page of one code change from its repository and number.
 * Undefined when no installed plugin builds links for the provider.
 */
export function codeChangeUrl(change: {
  number: number;
  provider: string;
  repository: string;
}): string | undefined {
  return codeLinks(change.provider)?.change(change);
}

/**
 * Read the code changes that a web page can be: the provider, repository,
 * and number that each installed plugin reads from the URL.
 */
export function parseCodeChangeUrl(
  url: string,
): Array<{ number: number; provider: string; repository: string }> {
  return getPlugins().flatMap((plugin) => {
    const change = plugin.codeLinks?.parseChange(url);
    return change ? [{ ...change, provider: plugin.manifest.name }] : [];
  });
}

/**
 * Build the web page of one repository from its name. Undefined when no
 * installed plugin builds links for the provider.
 */
export function codeRepositoryUrl(repository: {
  name: string;
  provider: string;
}): string | undefined {
  return codeLinks(repository.provider)?.repository(repository.name);
}
