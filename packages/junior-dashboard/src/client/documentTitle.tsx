import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { getDashboardAgentName } from "./agentName";

/**
 * Format a browser tab title as `{page} - {agent}`, or the agent name alone.
 * A count above zero comes first as `(N) `, as mail apps show unread mail.
 */
export function formatDocumentTitle(
  title: string | undefined,
  count?: number,
  agentName = getDashboardAgentName(),
): string {
  const page = title?.trim();
  const name = page ? `${page} - ${agentName}` : agentName;
  return count ? `(${count}) ${name}` : name;
}

type DocumentTitleOwner = {
  /** Drop the page's part, only while it is still `title`. */
  clearPage(title: string): void;
  setCount(count: number | undefined): void;
  setPage(title: string): void;
};

// Write the tab title only when its text changes: a pinned tab marks every
// write as an update.
function writeDocumentTitle(title: string) {
  if (document.title !== title) document.title = title;
}

// Without the provider, pages still set their title, with no count.
const DocumentTitleContext = createContext<DocumentTitleOwner>({
  clearPage: () => undefined,
  setCount: () => undefined,
  setPage: (title) => writeDocumentTitle(formatDocumentTitle(title)),
});

/**
 * Own the browser tab title: the current page's part, after the Inbox
 * count. Pages set their part with `useDocumentTitle`, and the shell sets
 * the count with `useDocumentTitleCount`.
 */
export function DocumentTitleProvider(props: { children: ReactNode }) {
  const page = useRef<string | undefined>(undefined);
  const count = useRef<number | undefined>(undefined);
  const owner = useMemo<DocumentTitleOwner>(() => {
    const apply = () =>
      writeDocumentTitle(formatDocumentTitle(page.current, count.current));
    return {
      clearPage(title) {
        if (page.current !== title) return;
        page.current = undefined;
        // A page that replaces this one sets its title in the same commit,
        // after this cleanup. Write after that, so the tab never shows the
        // bare agent name in between.
        queueMicrotask(apply);
      },
      setCount(next) {
        count.current = next;
        apply();
      },
      setPage(title) {
        page.current = title;
        apply();
      },
    };
  }, []);
  return (
    <DocumentTitleContext.Provider value={owner}>
      {props.children}
    </DocumentTitleContext.Provider>
  );
}

/**
 * Show the current page in the browser tab title.
 *
 * An empty title leaves the tab alone, so a parent without a title cannot
 * replace a child's title. Unmount restores the agent name, unless another
 * page has set its title since.
 */
export function useDocumentTitle(title: string | undefined): void {
  const owner = useContext(DocumentTitleContext);
  useEffect(() => {
    if (!title?.trim()) return;
    owner.setPage(title);
    return () => owner.clearPage(title);
  }, [owner, title]);
}

/** Show a count before every page's title, such as the Inbox count. */
export function useDocumentTitleCount(count: number | undefined): void {
  const owner = useContext(DocumentTitleContext);
  useEffect(() => owner.setCount(count), [owner, count]);
}
