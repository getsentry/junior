// Back-compat entrypoint: `pnpm evals` runs the behavioral suite.
// Prefer the suite-specific configs when selecting integration or Guardian.
export { default } from "./vitest.evals.behavioral.config";
