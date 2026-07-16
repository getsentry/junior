import type { PostgresHarnessConfig } from "@sentry/junior-testing/postgres";

/** Public and local control coordinates provided to eval test workers. */
export interface EvalEgressContext {
  baseUrl: string;
  controlToken: string;
  controlUrl: string;
  stateUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    juniorEvalEgress?: EvalEgressContext;
    juniorPostgresHarness?: PostgresHarnessConfig;
  }
}
