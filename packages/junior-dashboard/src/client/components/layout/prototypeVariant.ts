import { useLocation } from "react-router";

/**
 * Prototype only: read a design variant from a query param, such as
 * `?new=bar`, and keep it for this tab session so links keep it. The first
 * choice is the default. Not a setting; drop it once a variant is chosen.
 */
export function usePrototypeVariant<const T extends string>(
  param: string,
  choices: readonly [T, ...T[]],
): T {
  const value = new URLSearchParams(useLocation().search).get(param);
  const key = `junior:prototype:${param}`;
  const known = (candidate: string | null): candidate is T =>
    choices.includes(candidate as T);
  if (known(value)) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Storage is blocked; the param still picks this page's variant.
    }
    return value;
  }
  try {
    const saved = window.sessionStorage.getItem(key);
    if (known(saved)) return saved;
  } catch {
    // Storage is blocked; use the default.
  }
  return choices[0];
}
