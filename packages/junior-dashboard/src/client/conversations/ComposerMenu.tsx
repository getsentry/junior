import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { MatchedLabel } from "../components/MatchedLabel";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../styles";
import type { ComposerReference } from "./composerReferences";

/** A key that the open menu can take from the editor. */
export type ComposerMenuKey = "down" | "up" | "select" | "close" | "view";

/** What a menu row puts in place of the `$`, `@`, or `#` reference. */
export type ComposerInsertion =
  | { text: string }
  | { person: MentionablePerson }
  | { reference: ComposerReference };

/**
 * The editor side of one `$`, `@`, or `#` menu. The editor finds the reference at
 * the caret and owns the text; the menu owns the rows. Nothing here depends
 * on the editor library.
 */
export type ComposerTypeahead = {
  /** Characters after the trigger, up to the caret. Undefined when closed. */
  query: string | undefined;
  /** The whole name after the trigger, also after the caret. */
  name: string | undefined;
  /** True when text changed since the caret came to this reference. */
  edited: boolean;
  /** What the last insert put in, until the next edit or caret move. */
  inserted: string | undefined;
  /** The text box. The menu opens beside its form. */
  textbox: HTMLElement | null;
  /**
   * The screen box of the reference at the caret, or of the last insert,
   * so a card can sit on it. It changes when the reference moves.
   */
  referenceRect(): DOMRect | undefined;
  /** Replace the reference, then put the caret after a space. */
  insert(insertion: ComposerInsertion): void;
  /** Close the menu until the caret leaves this reference. */
  dismiss(): void;
  /** Put focus back in the text box, at its caret. */
  focus(): void;
  /**
   * Keep the menu open when the text box loses focus, while a press in the
   * menu runs. A tap blurs the text box before its click lands.
   */
  holdOpen(held: boolean): void;
  /**
   * Send menu keys to `handler` while the menu is open. It returns true when
   * it took the key. Returns the cleanup.
   */
  registerKeys(handler: (key: ComposerMenuKey) => boolean): () => void;
};

/**
 * One menu row: what it shows, the details pane of the active row, and what
 * it inserts.
 */
export type ComposerMenuRow = {
  key: string;
  /** The source that the row shows under, such as `People`. */
  group: string;
  icon: ReactNode;
  label: string;
  /** UTF-16 indices in `label` that the query matched. */
  labelMatches?: number[] | undefined;
  /** Muted text after the label, when the menu has no details pane. */
  hint?: string | undefined;
  details: ReactNode;
  insertion: ComposerInsertion;
  /**
   * The row is from an earlier query of its source, or still waits for
   * what it inserts. Only the API knows whether it still matches, so
   * Enter, Tab, and a click do nothing.
   */
  stale?: boolean | undefined;
};

/** The rows of one source, such as People, and whether it still loads. */
export type ComposerMenuSource = { pending: boolean; rows: ComposerMenuRow[] };

/**
 * Suggest rows while the reader types a reference, under a heading for each
 * source. Focus stays in the text box: arrows move at once, the pointer
 * after it rests on a row, Enter or Tab inserts, Escape closes. At 32rem
 * (`@lg`) a 14rem list sits beside the details of the active row. While
 * a source is `pending`, the menu is busy. Before its first rows, Enter and
 * Tab do nothing, so they do not send the half-typed reference.
 */
export function ComposerMenu(props: {
  label: string;
  sources: readonly ComposerMenuSource[];
  typeahead: ComposerTypeahead;
}) {
  const { typeahead } = props;
  const pending = props.sources.some((source) => source.pending);
  const rows = sourceRows(props.sources);
  const listboxId = useId();
  const detailsId = useId();
  // The active row is kept by key: a source that loads later can add rows
  // above it, and the highlight must stay on the same row.
  const [activeKey, setActiveKey] = useState<string>();
  const [placement, setPlacement] = useState<MenuPlacement>();
  // A row becomes active after the pointer rests on it. Each move restarts
  // the wait, so a diagonal move to the details pane keeps the row.
  const hoverTimer = useRef<number>(undefined);
  const cancelHover = () => window.clearTimeout(hoverTimer.current);
  const open = typeahead.query !== undefined && rows.length > 0;
  const active = Math.max(
    0,
    rows.findIndex((row) => row.key === activeKey),
  );
  const optionId = (index: number) => `${listboxId}-${index}`;

  // A new query starts at the first row.
  const [lastQuery, setLastQuery] = useState(typeahead.query);
  if (lastQuery !== typeahead.query) {
    setLastQuery(typeahead.query);
    setActiveKey(undefined);
  }

  // The composer moves with the layout, so follow it while the menu is open.
  const { textbox } = typeahead;
  useEffect(() => {
    if (!open || !textbox) return;
    const place = () => setPlacement(menuPlacement(textbox));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, textbox, typeahead.query]);

  useEffect(() => {
    if (!open) return;
    const move = (delta: number) => {
      cancelHover();
      setActiveKey(rows[(active + delta + rows.length) % rows.length]!.key);
    };
    const actions: Partial<Record<ComposerMenuKey, () => void>> = {
      down: () => move(1),
      up: () => move(-1),
      select: () => {
        const row = rows[active]!;
        if (!row.stale) typeahead.insert(row.insertion);
      },
      close: () => {
        cancelHover();
        typeahead.dismiss();
      },
    };
    return typeahead.registerKeys((key) => {
      const action = actions[key];
      action?.();
      return action !== undefined;
    });
  }, [active, open, rows, typeahead]);

  // Before the first rows arrive there is no menu, so Enter would send the
  // half-typed reference and Tab would leave the text box. Hold both.
  const waiting = typeahead.query !== undefined && !open && pending;
  useEffect(() => {
    if (!waiting) return;
    return typeahead.registerKeys((key) => key === "select");
  }, [typeahead, waiting]);

  // A text box supports these. `aria-expanded` needs the combobox role.
  useEffect(() => {
    if (!open || !textbox) return;
    textbox.setAttribute("aria-activedescendant", optionId(active));
    textbox.setAttribute("aria-controls", listboxId);
    document
      .getElementById(optionId(active))
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      textbox.removeAttribute("aria-activedescendant");
      textbox.removeAttribute("aria-controls");
    };
  });

  // A tap or a scrollbar drag in the menu blurs the text box. Mobile
  // browsers fire that blur after `pointerup`, so the click ends the press.
  // A drag or a scroll ends with no click, so the next press outside the
  // menu also ends it.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const endPress = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) {
        typeahead.holdOpen(false);
      }
    };
    document.addEventListener("pointerdown", endPress, true);
    return () => {
      document.removeEventListener("pointerdown", endPress, true);
      typeahead.holdOpen(false);
      cancelHover();
    };
  }, [open, typeahead]);

  // A portal, because docks around the composer clip their overflow.
  if (!open || !placement) return null;
  const groups = groupRows(rows);
  return createPortal(
    <div
      className="@container fixed z-50 flex overflow-hidden rounded-lg border border-input bg-secondary shadow-lg"
      // Keep focus and the caret in the text box on desktop.
      onMouseDown={(event) => event.preventDefault()}
      onPointerCancel={() => typeahead.holdOpen(false)}
      onPointerDown={() => typeahead.holdOpen(true)}
      ref={menuRef}
      style={placement}
    >
      <div
        aria-busy={pending}
        aria-label={props.label}
        className="thin-scrollbar min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5 @lg:w-56 @lg:flex-none"
        id={listboxId}
        onMouseLeave={cancelHover}
        role="listbox"
      >
        {groups.map((group) => (
          <div aria-label={group.label} key={group.label} role="group">
            <div
              aria-hidden="true"
              className="px-2.5 pt-1.5 pb-1 font-sans text-xs font-medium text-dashboard-text-muted"
            >
              {group.label}
            </div>
            {group.rows.map(({ index, row }) => (
              <div
                aria-describedby={index === active ? detailsId : undefined}
                aria-selected={index === active}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 font-sans text-sm text-foreground select-none",
                  index === active && "bg-dashboard-fill-hover",
                )}
                id={optionId(index)}
                key={row.key}
                onClick={() => {
                  cancelHover();
                  typeahead.holdOpen(false);
                  if (!row.stale) typeahead.insert(row.insertion);
                }}
                onMouseMove={() => {
                  cancelHover();
                  if (index === active) return;
                  hoverTimer.current = window.setTimeout(
                    () => setActiveKey(row.key),
                    HOVER_DWELL_MS,
                  );
                }}
                role="option"
              >
                {row.icon}
                <span className="min-w-0 truncate">
                  <MatchedLabel label={row.label} matches={row.labelMatches} />
                </span>
                {row.hint ? (
                  <span className="ml-auto min-w-0 shrink truncate text-xs text-dashboard-text-muted @lg:hidden">
                    {row.hint}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div
        className="hidden min-w-0 flex-1 flex-col gap-3 border-l border-input p-3 font-sans @lg:flex"
        id={detailsId}
      >
        {rows[active]!.details}
        <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-dashboard-text-muted">
          <Kbd>Enter</Kbd> insert · <Kbd>Esc</Kbd> close
        </div>
      </div>
    </div>,
    document.body,
  );
}

const HOVER_DWELL_MS = 120;

// Rows keep their order. Each source's rows are next to each other.
// A source that still loads can add rows above the sources after it, so
// their rows cannot be inserted yet.
function sourceRows(sources: readonly ComposerMenuSource[]): ComposerMenuRow[] {
  const rows: ComposerMenuRow[] = [];
  let waiting = false;
  for (const source of sources) {
    for (const row of source.rows)
      rows.push(waiting ? { ...row, stale: true } : row);
    waiting ||= source.pending;
  }
  return rows;
}

function groupRows(rows: readonly ComposerMenuRow[]) {
  const groups: {
    label: string;
    rows: { index: number; row: ComposerMenuRow }[];
  }[] = [];
  for (const [index, row] of rows.entries()) {
    const last = groups.at(-1);
    if (last?.label === row.group) last.rows.push({ index, row });
    else groups.push({ label: row.group, rows: [{ index, row }] });
  }
  return groups;
}

/**
 * The details of one menu row: its name, a line of facts, and longer text,
 * which scrolls.
 */
export function ComposerMenuDetails(props: {
  icon?: ReactNode;
  meta?: string | undefined;
  body?: string | undefined;
  title: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2 text-sm font-semibold [overflow-wrap:anywhere] text-foreground">
        {props.icon}
        <span className="min-w-0">{props.title}</span>
      </div>
      {props.meta ? (
        <div className="text-xs text-dashboard-text-muted">{props.meta}</div>
      ) : null}
      {props.body ? (
        <p className="thin-scrollbar m-0 mt-1 min-h-0 overflow-y-auto overscroll-contain text-sm [overflow-wrap:anywhere] whitespace-pre-line text-foreground">
          {props.body}
        </p>
      ) : null}
    </div>
  );
}

/** Where a composer popup sits: beside the composer form. */
export type MenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

// In rem, converted with the root font size: the free space is in px.
const MENU_MAX_REM = 20;
const MENU_GAP_REM = 0.5;
const CARD_MAX_REM = 28;

function rootRem(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/** The screen box of the composer that holds the text box. */
export function composerRect(textbox: HTMLElement): DOMRect {
  return (textbox.closest("form") ?? textbox).getBoundingClientRect();
}

/**
 * Open the menu on the side of the composer with more room, so the home
 * composer near the top of the page opens it downward.
 */
export function menuPlacement(textbox: HTMLElement): MenuPlacement {
  const rem = rootRem();
  const composer = composerRect(textbox);
  const gap = MENU_GAP_REM * rem;
  const above = composer.top;
  const below = window.innerHeight - composer.bottom;
  return {
    left: composer.left,
    width: composer.width,
    maxHeight: Math.min(MENU_MAX_REM * rem, Math.max(above, below) - 2 * gap),
    ...(below > above
      ? { top: composer.bottom + gap }
      : { bottom: window.innerHeight - composer.top + gap }),
  };
}

/**
 * Put a card on the reference that it describes: below it, or above it when
 * there is more room there. It is as wide as the composer, up to 28rem, and
 * stays over the composer, so it does not cover a side panel and on a phone
 * it spans the composer.
 */
export function cardPlacement(
  composer: DOMRect,
  reference: DOMRect,
): MenuPlacement {
  const rem = rootRem();
  const gap = MENU_GAP_REM * rem;
  const width = Math.min(CARD_MAX_REM * rem, composer.width);
  const above = reference.top;
  const below = window.innerHeight - reference.bottom;
  return {
    left: Math.max(
      composer.left,
      Math.min(reference.left, composer.right - width),
    ),
    width,
    maxHeight: Math.min(MENU_MAX_REM * rem, Math.max(above, below) - 2 * gap),
    ...(below > above
      ? { top: reference.bottom + gap }
      : { bottom: window.innerHeight - reference.top + gap }),
  };
}
