/** A GitHub repository, by owner and name. */
export interface Repository {
  name: string;
  owner: string;
}

/**
 * Read the `repo` config value as `owner/name`, or as `name` with the `org`
 * config value. Return undefined when neither form is complete.
 */
export function configuredRepository(
  config: Record<string, string>,
): Repository | undefined {
  const [first, second, ...extra] = (config["repo"] ?? "").trim().split("/");
  if (extra.length > 0) return undefined;
  const owner = second ? first : config["org"]?.trim();
  const name = second || first;
  return owner && name ? { owner, name } : undefined;
}
