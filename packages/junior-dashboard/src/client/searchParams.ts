import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** Build a same-page path that keeps the active query string. */
export function pathWithSearch(
  pathname: string,
  search: string | URLSearchParams | undefined,
): string {
  const ambient =
    typeof search === "string"
      ? search.startsWith("?")
        ? search.slice(1)
        : search
      : (search?.toString() ?? "");
  const separator = pathname.indexOf("?");
  const path = separator === -1 ? pathname : pathname.slice(0, separator);
  const existing =
    separator === -1 ? "" : pathname.slice(separator + 1).replace(/^\?+/, "");
  // Path-owned params win when a caller already baked a query into `pathname`.
  const merged = new URLSearchParams(ambient);
  for (const [key, value] of new URLSearchParams(existing)) {
    merged.set(key, value);
  }
  const query = merged.toString();
  return query ? `${path}?${query}` : path;
}

/** Accept only one of the allowed enum values from a query param. */
export function parseSearchParamEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
): T | undefined {
  const normalized = value?.trim();
  return normalized && (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : undefined;
}

/** Read and write one optional enum query param, omitting the default. */
export function useSearchParamEnum<T extends string>(
  key: string,
  defaultValue: T,
  allowed: readonly T[],
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value =
    parseSearchParamEnum(searchParams.get(key), allowed) ?? defaultValue;

  const setValue = useCallback(
    (nextValue: T) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (nextValue === defaultValue) next.delete(key);
          else next.set(key, nextValue);
          return next;
        },
        { replace: true },
      );
    },
    [defaultValue, key, setSearchParams],
  );

  return [value, setValue] as const;
}
