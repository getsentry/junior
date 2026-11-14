import {
  createContext,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { dockFalloff } from "@dashboard/lib/dock";
import { HoverPreviewGate } from "../components/ui/hover-preview";
import { useConversationDensity } from "../conversations/conversationDensity";

/**
 * The card in focus grows this much; its neighbors about half as much. The
 * list's side inset (`DOCK_GUTTER`) follows it.
 */
const DOCK_GROW = 0.05;

/**
 * The list's side inset: at least half of a grown card's extra width, so a
 * grown card never reaches the scroll area's edge. A percent padding reads
 * the scroll area's width, which is wider than any card.
 */
export const DOCK_GUTTER = `max(1.5rem, calc(${(DOCK_GROW / 2) * 100}% + 0.25rem))`;
const RADIUS_CARDS = 2;
/** Where a row may react to the pointer: a mouse, with motion allowed. */
export const DOCK_MEDIA =
  "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
/**
 * How long the pointer stays on a card before it grows. A pointer that
 * sweeps past cards moves nothing. Growing is only `transform`, so no row
 * moves.
 */
const FOCUS_INTENT_MS = 90;
/**
 * How long the pointer holds still before the card under it expands in
 * place, pushing the rows below. While the pointer moves, no row changes
 * height, so rows never run away from it.
 */
const REST_MS = 140;
/** As long as the card transitions in `inboxCardClass`, plus a frame. */
const SETTLE_MS = 260;
/**
 * How long the pointer holds still before a link preview may open. Cards
 * move for `SETTLE_MS` after a focus change, so this is longer.
 */
const STILL_MS = 300;

/** A card of a dock list, and the key it takes focus under. */
function cardKey(card: HTMLElement): string | undefined {
  return card.dataset.inboxRow ?? card.dataset.dockKey;
}

function dockCardOf(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  let card = target.closest<HTMLElement>("[data-dock-list] > li");
  // A card can hold its own list, as a pull request holds its asks: the
  // innermost card takes focus.
  while (card && cardKey(card) === undefined) {
    card =
      card.parentElement?.closest<HTMLElement>("[data-dock-list] > li") ?? null;
  }
  return card ?? undefined;
}

function outermostCard(card: HTMLElement): HTMLElement {
  let outer = card;
  for (
    let next = outer.parentElement?.closest<HTMLElement>(
      "[data-dock-list] > li",
    );
    next;
    next = outer.parentElement?.closest<HTMLElement>("[data-dock-list] > li")
  )
    outer = next;
  return outer;
}

/**
 * Where a card's box sits in the scroll area's content, without its scale:
 * a transform does not move layout.
 */
function layoutTop(card: HTMLElement, scroller: HTMLElement): number {
  const transform = getComputedStyle(card).transform;
  const scale = transform === "none" ? 1 : new DOMMatrix(transform).d;
  const shift = (card.offsetHeight * (scale - 1)) / 2;
  return (
    card.getBoundingClientRect().top +
    shift -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop
  );
}

type FocusState = {
  /** The card that grows under the pointer. */
  key?: string;
  /** The card that the pointer last rested on: it expands in place. */
  restKey?: string;
  /** The pointer has not moved for `STILL_MS`, and no card is moving. */
  still: boolean;
};

function createFocusStore() {
  let state: FocusState = { still: true };
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    update(next: Partial<FocusState>) {
      const merged = { ...state, ...next };
      if (
        merged.key === state.key &&
        merged.restKey === state.restKey &&
        merged.still === state.still
      )
        return false;
      state = merged;
      for (const listener of listeners) listener();
      return true;
    },
  };
}

type FocusStore = ReturnType<typeof createFocusStore>;

const FocusContext = createContext<FocusStore | undefined>(undefined);

/** Lets the rows of a list read the card in focus from `useInboxFocus`. */
export function InboxFocusProvider(props: {
  children: ReactNode;
  focus: FocusStore;
}) {
  return <FocusContext value={props.focus}>{props.children}</FocusContext>;
}

function useFocusStore<T>(read: (state: FocusState) => T, fallback: T): T {
  const store = useContext(FocusContext);
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        store ? store.subscribe(onChange) : () => undefined,
      [store],
    ),
    () => (store ? read(store.read()) : fallback),
    () => fallback,
  );
}

/**
 * Hold link previews in the list while the pointer moves, so a pointer
 * that crosses cards, or rests while they still move, opens none. A
 * keyboard never moves the pointer, so focus opens them as before.
 */
export function InboxPreviewGate(props: { children: ReactNode }) {
  const still = useFocusStore((state) => state.still, true);
  return <HoverPreviewGate open={still}>{props.children}</HoverPreviewGate>;
}

/** True while the Inbox card with this key has the pointer's rest. */
export function useInboxRowFocused(key: string): boolean {
  return useFocusStore((state) => state.restKey === key, false);
}

/**
 * One driver for an Inbox list's pointer motion. The card the pointer
 * rests on takes focus; it and its neighbors grow on one transition, like
 * a dock, and a row in focus can expand in place (`useInboxRowFocused`).
 * While cards above it change height, the scroll area moves with them, so
 * the card under the pointer holds still. Spread `handlers` on the scroll
 * area, and wrap the list in `InboxFocusProvider`.
 */
export function useInboxFocus(
  scroller: RefObject<HTMLElement | null>,
  expandedKey: string,
) {
  // Compact rows do not grow; one in focus may still expand.
  const [density] = useConversationDensity();
  const grows = density === "comfortable";
  const [store] = useState(createFocusStore);
  const pending = useRef<string>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stillTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const restTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastPoint = useRef("");
  const frame = useRef(0);
  const scaled = useRef(new Set<HTMLElement>());

  const unscale = useCallback((card: HTMLElement) => {
    card.style.transform = "";
    card.style.willChange = "";
    scaled.current.delete(card);
  }, []);

  // Grow the card in focus and the cards near it in its list. An open card
  // stays still.
  const applyScale = useCallback(() => {
    const { key } = store.read();
    const focused = key
      ? scroller.current?.querySelector<HTMLElement>(
          `[data-dock-list] > li[data-inbox-row="${CSS.escape(key)}"], [data-dock-list] > li[data-dock-key="${CSS.escape(key)}"]`,
        )
      : null;
    // A card in a card, as an ask in its pull request, grows its outer
    // card among the list's cards.
    const outer = focused ? outermostCard(focused) : null;
    const cards = outer?.parentElement
      ? [...outer.parentElement.children].filter(
          (child): child is HTMLElement => child instanceof HTMLLIElement,
        )
      : [];
    const at = outer ? cards.indexOf(outer) : -1;
    for (const card of scaled.current) if (!cards.includes(card)) unscale(card);
    for (const [index, card] of cards.entries()) {
      const grow =
        grows && card.dataset.expanded === undefined
          ? dockFalloff(Math.abs(index - at), RADIUS_CARDS)
          : 0;
      if (grow === 0) {
        if (scaled.current.has(card)) unscale(card);
        continue;
      }
      // Neighbors stretch a little more in height than in width, so the
      // list reads as one surface under a lens.
      const x = 1 + DOCK_GROW * grow * (index === at ? 1 : 0.7);
      const y = 1 + DOCK_GROW * grow;
      card.style.transform = `scale(${x.toFixed(4)}, ${y.toFixed(4)})`;
      card.style.willChange = "transform";
      scaled.current.add(card);
    }
  }, [grows, scroller, store, unscale]);
  // A card that opens or closes, or a density change, scales again.
  useEffect(applyScale, [applyScale, expandedKey]);

  const setFocus = useCallback(
    (key: string | undefined) => {
      if (store.update({ key })) applyScale();
    },
    [applyScale, store],
  );

  const setRest = useCallback(
    (key: string | undefined, card?: HTMLElement) => {
      if (!store.update({ restKey: key })) return;
      const area = scroller.current;
      cancelAnimationFrame(frame.current);
      if (!card || !area) return;
      // Hold the card under the pointer still while the card that lost
      // focus collapses above it.
      const top = layoutTop(card, area);
      const until = performance.now() + SETTLE_MS;
      const hold = () => {
        if (!card.isConnected) return;
        const drift = layoutTop(card, area) - top;
        if (Math.abs(drift) >= 0.5) area.scrollTop += drift;
        if (performance.now() < until)
          frame.current = requestAnimationFrame(hold);
      };
      frame.current = requestAnimationFrame(hold);
    },
    [scroller, store],
  );

  const setStill = useCallback(
    (still: boolean) => {
      store.update({ still });
    },
    [store],
  );

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    clearTimeout(stillTimer.current);
    clearTimeout(restTimer.current);
    lastPoint.current = "";
    setStill(true);
    pending.current = undefined;
    setFocus(undefined);
    setRest(undefined);
  }, [setFocus, setRest, setStill]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(stillTimer.current);
      clearTimeout(restTimer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") return;
      if (!window.matchMedia(DOCK_MEDIA).matches) return clear();
      // The browser also sends a move when the page scrolls or moves under
      // a still pointer. Only the reader's own moves count.
      const point = `${event.clientX},${event.clientY}`;
      if (point === lastPoint.current) return;
      lastPoint.current = point;
      setStill(false);
      clearTimeout(stillTimer.current);
      stillTimer.current = setTimeout(() => setStill(true), STILL_MS);
      // Rows may have moved under a resting pointer, so read what is under
      // it when the rest begins.
      const { clientX, clientY } = event;
      clearTimeout(restTimer.current);
      restTimer.current = setTimeout(() => {
        const rested = dockCardOf(document.elementFromPoint(clientX, clientY));
        const restKey = rested ? cardKey(rested) : undefined;
        if (!rested || !restKey) return;
        pending.current = restKey;
        setFocus(restKey);
        setRest(restKey, rested);
      }, REST_MS);
      const card = dockCardOf(event.target);
      const key = card ? cardKey(card) : undefined;
      if (key === pending.current) return;
      pending.current = key;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setFocus(key), FOCUS_INTENT_MS);
    },
    [clear, setFocus, setRest, setStill],
  );

  return {
    /** Pass to `InboxFocusProvider` around the list. */
    focus: store,
    handlers: { onPointerLeave: clear, onPointerMove },
  };
}

/** What takes Esc before the open row: menus, dialogs and popovers. */
const ESCAPE_OWNERS =
  "[data-dashboard-modal], [data-escape-owner], [role='dialog'], [role='menu'], [role='listbox']";

/**
 * Collapse the open row on a click outside it, in empty list or page
 * space, or on Esc. A click on a control, another row, a menu, a popover
 * or a toast is that control's, and Esc in a text box stays there.
 */
export function useCollapseOutside(expandedKey: string, collapse: () => void) {
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;
  useEffect(() => {
    if (!expandedKey) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (
        target.closest(
          `li[data-inbox-row], a, button, input, textarea, select, label, [contenteditable='true'], [data-sonner-toaster], ${ESCAPE_OWNERS}`,
        )
      )
        return;
      // A drag that selects text is not a click.
      if (window.getSelection()?.toString()) return;
      collapseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [data-escape-scope]",
        ) ||
        document.querySelector(ESCAPE_OWNERS)
      )
        return;
      event.preventDefault();
      collapseRef.current();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expandedKey]);
}
