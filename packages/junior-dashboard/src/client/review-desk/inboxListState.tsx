import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";

import { parseInboxView, type InboxView } from "./inboxModel";

/** How many rows of a stream show before the reader scrolls for more. */
const INBOX_PAGE_SIZE = 25;

/** Where the reader is in one list. */
type ListPlace = { expandedKey: string; loaded: number };

type InboxListValue = {
  places: Readonly<Record<string, ListPlace>>;
  /** The list that Back returns to: the last one shown. */
  returnPath: string;
  /** Scroll offsets by list, kept without a render. */
  scroll: Map<string, number>;
  setPlace(listPath: string, place: Partial<ListPlace>): void;
  setReturnPath(listPath: string): void;
};

const InboxListContext = createContext<InboxListValue | null>(null);

const NEW_PLACE: ListPlace = { expandedKey: "", loaded: INBOX_PAGE_SIZE };

/**
 * Keep the place of each Inbox list for the session: its entry, scroll
 * position, expanded row, and how many rows it shows. Opening a
 * Conversation replaces the list, and Back brings it back as it was.
 */
export function InboxListProvider(props: { children: ReactNode }) {
  const [places, setPlaces] = useState<Readonly<Record<string, ListPlace>>>({});
  const [returnPath, setReturnPath] = useState("/");
  const scroll = useRef(new Map<string, number>()).current;
  const setPlace = useCallback(
    (listPath: string, place: Partial<ListPlace>) =>
      setPlaces((current) => ({
        ...current,
        [listPath]: { ...NEW_PLACE, ...current[listPath], ...place },
      })),
    [],
  );
  const value = useMemo(
    () => ({ places, returnPath, scroll, setPlace, setReturnPath }),
    [places, returnPath, scroll, setPlace],
  );
  return (
    <InboxListContext.Provider value={value}>
      {props.children}
    </InboxListContext.Provider>
  );
}

function useInboxListContext(): InboxListValue {
  const value = useContext(InboxListContext);
  if (!value) throw new Error("Inbox lists require InboxListProvider");
  return value;
}

/** The list path without the one-time `item` link, which names no place. */
function listPathOf(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("item");
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/**
 * Own the place of the Inbox list that shows now: its entry from the URL,
 * the expanded row, how many rows show, and the scroll position. The
 * scroll comes back once `ready` says the rows are there.
 */
export function useInboxListState(ready: boolean) {
  const list = useInboxListContext();
  const location = useLocation();
  const listPath = listPathOf(location.pathname, location.search);
  const view: InboxView = parseInboxView(
    new URLSearchParams(location.search).get("view"),
  );
  const place = list.places[listPath] ?? NEW_PLACE;
  const { scroll, setPlace, setReturnPath } = list;

  useEffect(() => setReturnPath(listPath), [listPath, setReturnPath]);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && scroller.current)
      scroller.current.scrollTop = scroll.get(listPath) ?? 0;
  }, [listPath, ready, scroll]);

  return {
    expandedKey: place.expandedKey,
    listPath,
    loaded: place.loaded,
    onScroll: (event: { currentTarget: HTMLElement }) =>
      scroll.set(listPath, event.currentTarget.scrollTop),
    scroller,
    setExpandedKey: (expandedKey: string) =>
      setPlace(listPath, { expandedKey }),
    showMore: () =>
      setPlace(listPath, { loaded: place.loaded + INBOX_PAGE_SIZE }),
    toggle: (key: string) =>
      setPlace(listPath, {
        expandedKey: place.expandedKey === key ? "" : key,
      }),
    view,
  };
}

/** The Inbox list that Back returns to: the last one shown, or the Inbox. */
export function useInboxReturnPath(): string {
  return useInboxListContext().returnPath;
}
