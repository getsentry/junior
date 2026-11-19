import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { cn } from "../styles";

/** A key that the open menu can take from the editor. */
export type ComposerMenuKey = "down" | "up" | "select" | "close" | "view";

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
 * Suggest rows while the reader types a reference. Focus stays in the text
 * box: arrows move, Enter or Tab inserts, Escape closes. While `pending`,
 * the rows are from an earlier query: Enter and Tab do nothing, so they
 * neither insert a stale row nor send the message.
 */
export function ComposerMenu<Row>(props: {
  children(row: Row): ReactNode;
  label: string;
  onSelect(row: Row): void;
  pending?: boolean | undefined;
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
  const { onSelect, pending } = props;

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
    const actions: Partial<Record<ComposerMenuKey, () => void>> = {
      down: () => setActiveIndex((active + 1) % rows.length),
      up: () => setActiveIndex((active - 1 + rows.length) % rows.length),
      select: () => {
        if (!pending) onSelect(rows[active]!);
      },
      close: () => typeahead.dismiss(),
    };
    return typeahead.registerKeys((key) => {
      const action = actions[key];
      action?.();
      return action !== undefined;
    });
  }, [active, onSelect, open, pending, rows, typeahead]);

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
      aria-busy={pending}
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
            if (!pending) onSelect(row);
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
