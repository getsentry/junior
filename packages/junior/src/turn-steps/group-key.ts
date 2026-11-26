// Junior's rule for which inputs share a core Turn. Inputs from one Actor and
// one Source kind share a Turn, so a Turn acts for one Actor and never mixes
// Sources. Core only compares the key. A Source kind has no colon, so two
// Actor-and-Source pairs never get the same key.
import type { Source } from "@sentry/junior-plugin-api";

/** The group key of an input that this Actor Identity sent from this Source. */
export function turnGroupKey(
  actorIdentityId: string,
  source: Pick<Source, "kind">,
): string {
  return `${actorIdentityId}:${source.kind}`;
}
