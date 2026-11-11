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

import type { OlderConversationPages } from "../api";
import { parseInboxView, type InboxView } from "./inboxModel";

/** How many rows of a stream show before the reader scrolls for more. */
const INBOX_PAGE_SIZE = 25;

/** Where the reader is in one list. */
type ListPlace = { expandedKey: string; loaded: number };

/**
 * Items that a link opened past the loaded pages: an open one joins every
 * list, and a closed one joins Done.
 */
type LinkedItems = { closed?: string; open?: string };

type InboxListValue = {
  linkedItems: readonly [
    LinkedItems,
    (update: (current: LinkedItems) => LinkedItems) => void,
  ];
  /** Mark that the composer shows; true the first time this session. */
  showComposer(): boolean;
  /** The feed pages after the first that the lists have loaded. */
  olderPages: readonly [
    OlderConversationPages,
    (pages: OlderConversationPages) => void,
  ];
  /** Places by list, so `/` and `/?view=inbox` share the Inbox's. */
  places: Readonly<Partial<Record<InboxView, ListPlace>>>;
  /** The list that Back returns to: the last one shown. */
  returnPath: string;
  /** Scroll offsets by list, kept without a render. */
  scroll: Map<InboxView, number>;
  setPlace(view: InboxView, place: Partial<ListPlace>): void;
  setReturnPath(listPath: string): void;
};

const InboxListContext = createContext<InboxListValue | null>(null);

const NEW_PLACE: ListPlace = { expandedKey: "", loaded: INBOX_PAGE_SIZE };

/**
 * Keep the place of each Inbox list for the session: its entry, scroll
 * position, expanded row, how many rows it shows, the older feed pages it
 * loaded, and the items that links added. Opening a Conversation replaces the list, and Back brings it
 * back as it was.
 */
export function InboxListProvider(props: { children: ReactNode }) {
  const [places, setPlaces] = useState<
    Readonly<Partial<Record<InboxView, ListPlace>>>
  >({});
  const [linkedItems, setLinkedItems] = useState<LinkedItems>({});
  const [returnPath, setReturnPath] = useState("/");
  const [olderPages, setOlderPages] = useState<OlderConversationPages>({
    after: undefined,
    cursors: [],
  });
  const composerShown = useRef(false);
  const showComposer = useCallback(() => {
    const first = !composerShown.current;
    composerShown.current = true;
    return first;
  }, []);
  const scroll = useRef(new Map<InboxView, number>()).current;
  const setPlace = useCallback(
    (view: InboxView, place: Partial<ListPlace>) =>
      setPlaces((current) => {
        const next = { ...NEW_PLACE, ...current[view], ...place };
        const shown = current[view];
        // An unchanged place keeps its object, so effects that set it on
        // each render, such as an item link's, do not render again.
        if (
          shown &&
          shown.expandedKey === next.expandedKey &&
          shown.loaded === next.loaded
        ) {
          return current;
        }
        return { ...current, [view]: next };
      }),
    [],
  );
  const value = useMemo(
    () => ({
      linkedItems: [linkedItems, setLinkedItems] as const,
      olderPages: [olderPages, setOlderPages] as const,
      places,
      returnPath,
      scroll,
      setPlace,
      setReturnPath,
      showComposer,
    }),
    [
      linkedItems,
      olderPages,
      places,
      returnPath,
      scroll,
      setPlace,
      showComposer,
    ],
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
  const place = list.places[view] ?? NEW_PLACE;
  const { scroll, setPlace, setReturnPath } = list;

  useEffect(() => setReturnPath(listPath), [listPath, setReturnPath]);

  // Stable, because the item link effect depends on it.
  const setExpandedKey = useCallback(
    (expandedKey: string) => setPlace(view, { expandedKey }),
    [setPlace, view],
  );

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && scroller.current)
      scroller.current.scrollTop = scroll.get(view) ?? 0;
  }, [listPath, ready, scroll, view]);

  return {
    expandedKey: place.expandedKey,
    listPath,
    loaded: place.loaded,
    onScroll: (event: { currentTarget: HTMLElement }) =>
      scroll.set(view, event.currentTarget.scrollTop),
    scroller,
    setExpandedKey,
    showMore: () => setPlace(view, { loaded: place.loaded + INBOX_PAGE_SIZE }),
    toggle: (key: string) =>
      setPlace(view, {
        expandedKey: place.expandedKey === key ? "" : key,
      }),
    view,
  };
}

/** The Inbox list that Back returns to: the last one shown, or the Inbox. */
export function useInboxReturnPath(): string {
  return useInboxListContext().returnPath;
}

/**
 * The older feed pages that the Inbox lists have loaded, for
 * `useOlderConversationPages`. They last the session, so Back restores
 * every row that was loaded.
 */
export function useOlderConversationPagesState() {
  return useInboxListContext().olderPages;
}

/**
 * The items that links added past the loaded pages, for the session. A tab
 * switch or a remount keeps them, so a linked row stays in its list.
 */
export function useLinkedInboxItems() {
  return useInboxListContext().linkedItems;
}

/**
 * Mark that the composer shows, and say whether it is the first time this
 * session. A remount keeps the answer, so a Back into the composer does
 * not count as the first visit.
 */
export function useShowComposer(): () => boolean {
  return useInboxListContext().showComposer;
}
