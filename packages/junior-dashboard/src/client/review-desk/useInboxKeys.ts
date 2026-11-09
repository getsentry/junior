import { useEffect, useRef } from "react";

/** What each inbox key does. The page owns the state behind them. */
export type InboxKeyActions = {
  /** Move the active bundle by one, down (1) or up (-1). */
  move(step: 1 | -1): void;
  toggle(): void;
  done(): void;
  snoozeMenu(): void;
  /** Pick snooze choice `index` while the snooze menu is open. */
  snoozeChoice(index: number): boolean;
  escape(): boolean;
  open(): void;
  reply(): void;
};

const EDITABLE = "input, textarea, select, [contenteditable='true']";
const INTERACTIVE = `${EDITABLE}, a, button, [role='radio'], [role='checkbox']`;

/**
 * Bind the inbox triage keys, as in Gmail and Linear: j/k move, Enter opens,
 * e done, h snooze, o opens the Conversation, r replies. Keys do nothing
 * while a text field has focus, so typing an answer is safe.
 */
export function useInboxKeys(actions: InboxKeyActions): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (event.altKey || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(EDITABLE)) return;
      const run = ref.current;
      const handled = (() => {
        switch (event.key) {
          case "j":
            run.move(1);
            return true;
          case "k":
            run.move(-1);
            return true;
          case "Enter":
            // A focused control handles its own Enter.
            if (target?.closest(INTERACTIVE)) return false;
            run.toggle();
            return true;
          case "e":
            run.done();
            return true;
          case "h":
            run.snoozeMenu();
            return true;
          case "o":
            run.open();
            return true;
          case "r":
            run.reply();
            return true;
          case "Escape":
            return run.escape();
          default:
            return /^[1-9]$/.test(event.key)
              ? run.snoozeChoice(Number(event.key) - 1)
              : false;
        }
      })();
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
