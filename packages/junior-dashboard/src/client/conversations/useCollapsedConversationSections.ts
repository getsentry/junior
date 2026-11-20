import { useCallback, useState } from "react";

const STORAGE_KEY = "junior:conversation-collapsed-sections";

type CollapsedConversationSections = {
  collapsedKeys: ReadonlySet<string>;
  toggle(key: string): void;
};

/** Keep the collapsed conversation sections of this browser. */
export function useCollapsedConversationSections(): CollapsedConversationSections {
  const [collapsedKeys, setCollapsedKeys] = useState(readCollapsedKeys);
  const toggle = useCallback((key: string) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      writeCollapsedKeys(next);
      return next;
    });
  }, []);
  return { collapsedKeys, toggle };
}

function readCollapsedKeys(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set();

  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter((key): key is string => typeof key === "string"),
    );
  } catch {
    return new Set();
  }
}

function writeCollapsedKeys(keys: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Keep in-memory collapse state usable when storage is unavailable.
  }
}
