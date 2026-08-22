/**
 * Reinterpret a value as another type through one opaque cast.
 *
 * Prefer a real parse or type guard. Use this only when the surrounding code
 * already established the runtime shape and TypeScript cannot see it.
 */
export function castThroughUnknown<T>(value: unknown): T {
  return value as T;
}
