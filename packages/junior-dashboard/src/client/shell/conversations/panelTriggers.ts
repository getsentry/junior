// A closed side panel returns focus to the control that opened it.

/** Find the event log row button that opened an event's details. */
export function eventDetailsTrigger(
  root: HTMLElement | null,
  seq: number | undefined,
): HTMLButtonElement | undefined {
  return (
    root?.querySelector<HTMLButtonElement>(
      `[data-event-seq="${seq}"] button`,
    ) ?? undefined
  );
}

/**
 * Find the control that opened a message's Turn context. A message can have
 * one context control per layout, so take the visible one.
 */
export function turnContextTrigger(
  root: HTMLElement | null,
  id: string | undefined,
): HTMLButtonElement | undefined {
  return [
    ...(root?.querySelectorAll<HTMLButtonElement>(
      `[data-turn-context-id="${CSS.escape(id ?? "")}"]`,
    ) ?? []),
  ].find((button) => button.getClientRects().length > 0);
}
