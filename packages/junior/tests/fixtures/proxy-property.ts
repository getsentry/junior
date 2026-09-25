/** Read one property through ordinary access for Proxy get traps. */
export function readProxyProperty<T extends object>(
  target: T,
  property: PropertyKey,
): unknown {
  return (target as Record<PropertyKey, unknown>)[property];
}
