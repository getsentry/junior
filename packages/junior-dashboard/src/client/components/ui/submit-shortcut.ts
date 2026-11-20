import type { KeyboardEvent } from "react";

/**
 * Send the form of a text control on Ctrl+Enter or Cmd+Enter. Every dashboard
 * text box takes this shortcut, and the `text-control` lint rule keeps text
 * boxes on the controls that call it. A control outside a form ignores it.
 */
export function submitFormOnModEnter(
  event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
) {
  if (
    event.defaultPrevented ||
    event.key !== "Enter" ||
    !(event.ctrlKey || event.metaKey) ||
    event.nativeEvent.isComposing
  ) {
    return;
  }
  const form = event.currentTarget.form;
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}
