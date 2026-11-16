import { fileURLToPath } from "node:url";
import {
  compareToBaseline,
  countMatches,
  runRatchet,
} from "./source-ratchet.mjs";

/**
 * Type assertion ratchet for production source. A type assertion (`x as T` or
 * `<T>x`) tells the compiler to trust a shape that nothing checked. Data must
 * be parsed at its edge, and later code must use the parsed types. The
 * baseline lists the per-file count of the assertions that existed when this
 * check was added. A count can only go down.
 */

const RATCHET = {
  title: "Type assertion",
  label: "type assertions",
  baselinePath: "scripts/type-assertions-baseline.json",
  message:
    "Do not add type assertions (`as T`, `<T>x`). Parse unknown input with its owning zod schema at the edge, narrow with a discriminant or a type guard, or use `satisfies` to check a value against a type. See policies/runtime-boundary-schemas.md.",
  passMessage: "Production source adds no type assertions.",
};

// `as const` only narrows a literal, so it is not counted. A chain such as
// `x as unknown as T` counts as two assertions.
// `.tsx` files have no `<T>x` form, because it would parse as JSX.
const RULES = `id: type-assertion-ts
language: TypeScript
rule:
  any:
    - kind: type_assertion
    - all:
        - kind: as_expression
        - not: { pattern: $X as const }
---
id: type-assertion-tsx
language: Tsx
rule:
  all:
    - kind: as_expression
    - not: { pattern: $X as const }`;

/**
 * Count type assertions per file, so comments, strings, and import aliases
 * are not counted. Paths in the result are relative to `root`.
 */
export function countTypeAssertions(root, targets) {
  return countMatches(root, targets, RULES);
}

/** Compare type assertion counts with the baseline. */
export function checkTypeAssertions(counts, baseline) {
  return compareToBaseline(counts, baseline, RATCHET);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRatchet({ ...RATCHET, rules: RULES });
}
