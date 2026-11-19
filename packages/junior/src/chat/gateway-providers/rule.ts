/**
 * The routing rule of the "Enabled providers" admin setting.
 *
 * This module imports nothing, so the dashboard client bundle can use it.
 */

/**
 * Return the AI Gateway `only` list for one model, or undefined to send none.
 *
 * `enabled` is null when every provider is enabled. `served` lists the
 * providers that serve the model. A model that no enabled provider serves
 * stays unfiltered, so unchecking its providers can never break it. A filter
 * that keeps every provider of the model changes nothing, so it is not sent.
 */
export function gatewayOnlyProviders(
  enabled: readonly string[] | null,
  served: readonly string[],
): string[] | undefined {
  if (enabled === null) return undefined;
  const only = served.filter((provider) => enabled.includes(provider));
  return only.length > 0 && only.length < served.length ? only : undefined;
}
