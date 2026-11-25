import type { UserSearchResult } from "@sentry/junior/api/schema";

/** The name the people picker shows for a User. */
export function pickerName(user: UserSearchResult): string {
  return user.fullName ?? user.slackUserName ?? user.email;
}

/**
 * The search results that the picker offers: Users not chosen yet. A User
 * who already belongs stays in the list so the reader sees why, but cannot
 * be chosen.
 */
export function pickerOptions(
  users: readonly UserSearchResult[],
  chosen: readonly UserSearchResult[],
): UserSearchResult[] {
  const chosenIds = new Set(chosen.map((user) => user.userId));
  return users.filter((user) => !chosenIds.has(user.userId));
}

/**
 * The option that ArrowDown (`step` 1) or ArrowUp (-1) moves to from
 * `active`: the next one that can be chosen, wrapping at the ends. -1 when
 * none can be chosen. From -1, ArrowDown goes to the first and ArrowUp to
 * the last.
 */
export function movePickerActive(
  options: readonly UserSearchResult[],
  active: number,
  step: 1 | -1,
): number {
  const count = options.length;
  let index = active < 0 ? (step === 1 ? -1 : count) : active;
  for (let tries = 0; tries < count; tries++) {
    index = (index + step + count) % count;
    if (!options[index]!.isMember) return index;
  }
  return -1;
}
