// Back-compat entrypoint: `pnpm evals` runs the qualitative suite.
// Prefer the suite-specific configs when selecting invariant or Guardian.
export { default } from "./vitest.evals.qualitative.config";
