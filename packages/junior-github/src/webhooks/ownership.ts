const GITHUB_NOREPLY_DOMAIN = "users.noreply.github.com";

/** Derive the provider login encoded in a standard GitHub noreply address. */
export function botLoginFromEmail(
  value: string | undefined,
): string | undefined {
  const email = value?.trim();
  if (!email) return undefined;
  const separator = email.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const domain = email.slice(separator + 1).toLowerCase();
  if (domain !== GITHUB_NOREPLY_DOMAIN) return undefined;
  const localPart = email.slice(0, separator);
  const login = localPart.slice(localPart.indexOf("+") + 1).trim();
  return login.toLowerCase().endsWith("[bot]") ? login : undefined;
}
