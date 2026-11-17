import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { cn } from "../styles";

/** A key that the open menu can take from the editor. */
export type ComposerMenuKey = "down" | "up" | "select" | "close";

/** What a menu row puts in place of the `$` or `@` reference. */
export type ComposerInsertion =
  | { text: string }
  | { person: MentionablePerson };

/**
 * The editor side of one `$` or `@` menu. The editor finds the reference at
 * the caret and owns the text; the menu owns the rows. Nothing here depends
 * on the editor library.
 */
export type ComposerTypeahead = {
  /** Characters after the trigger, up to the caret. Undefined when closed. */
  query: string | undefined;
  /** The text box. The menu opens beside its form. */
  textbox: HTMLElement | null;
  /** Replace the reference, then put the caret after a space. */
  insert(insertion: ComposerInsertion): void;
  /** Close the menu until the caret leaves this reference. */
  dismiss(): void;
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
 * Suggest rows while the reader types a reference. Focus stays in the text
 * box: arrows move, Enter or Tab inserts, Escape closes.
 */
export function ComposerMenu<Row>(props: {
  children(row: Row): ReactNode;
  label: string;
  onSelect(row: Row): void;
  rowKey(row: Row): string;
  rows: readonly Row[];
  typeahead: ComposerTypeahead;
}) {
  const { rows, typeahead } = props;
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<MenuPlacement>();
  const open = typeahead.query !== undefined && rows.length > 0;
  const active = Math.min(activeIndex, rows.length - 1);
  const optionId = (index: number) => `${listboxId}-${index}`;
  const { onSelect } = props;

  // A new query starts at the first row.
  const [lastQuery, setLastQuery] = useState(typeahead.query);
  if (lastQuery !== typeahead.query) {
    setLastQuery(typeahead.query);
    setActiveIndex(0);
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
    return typeahead.registerKeys((key) => {
      switch (key) {
        case "down":
          setActiveIndex((active + 1) % rows.length);
          return true;
        case "up":
          setActiveIndex((active - 1 + rows.length) % rows.length);
          return true;
        case "select":
          onSelect(rows[active]!);
          return true;
        case "close":
          typeahead.dismiss();
          return true;
      }
    });
  }, [active, onSelect, open, rows, typeahead]);

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
  useEffect(() => {
    if (!open) return;
    const endPress = (event: PointerEvent) => {
      const menu = document.getElementById(listboxId);
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) {
        typeahead.holdOpen(false);
      }
    };
    document.addEventListener("pointerdown", endPress, true);
    return () => {
      document.removeEventListener("pointerdown", endPress, true);
      typeahead.holdOpen(false);
    };
  }, [listboxId, open, typeahead]);

  // A portal, because docks around the composer clip their overflow.
  if (!open || !placement) return null;
  return createPortal(
    <div
      aria-label={props.label}
      className="thin-scrollbar fixed z-50 overflow-y-auto overscroll-contain rounded-lg border border-input bg-secondary p-1.5 shadow-lg"
      id={listboxId}
      // Keep focus and the caret in the text box on desktop.
      onMouseDown={(event) => event.preventDefault()}
      onPointerCancel={() => typeahead.holdOpen(false)}
      onPointerDown={() => typeahead.holdOpen(true)}
      role="listbox"
      style={placement}
    >
      {rows.map((row, index) => (
        <div
          aria-selected={index === active}
          className={cn(
            "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 font-sans text-sm text-foreground select-none",
            index === active && "bg-dashboard-fill-hover",
          )}
          id={optionId(index)}
          key={props.rowKey(row)}
          onClick={() => {
            typeahead.holdOpen(false);
            onSelect(row);
          }}
          onMouseMove={
            index === active ? undefined : () => setActiveIndex(index)
          }
          role="option"
        >
          {props.children(row)}
        </div>
      ))}
    </div>,
    document.body,
  );
}

type MenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

// In rem, converted with the root font size: the free space is in px.
const MENU_MAX_REM = 20;
const MENU_GAP_REM = 0.5;

/**
 * Open the menu on the side of the composer with more room, so the home
 * composer near the top of the page opens it downward.
 */
function menuPlacement(textbox: HTMLElement): MenuPlacement {
  const rem = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const composer = (textbox.closest("form") ?? textbox).getBoundingClientRect();
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
