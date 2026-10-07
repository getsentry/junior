import type { PostgresHarnessConfig } from "@sentry/junior-testing/postgres";

/** Invocation-wide egress and state coordinates provided to eval workers. */
export interface EvalInvocationContext {
  baseUrl: string;
  controlToken: string;
  controlUrl: string;
  redisUrl: string;
  stateKeyPrefix: string;
  stateUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    juniorEvalContext?: EvalInvocationContext;
    juniorPostgresHarness?: PostgresHarnessConfig;
    /** The recording proxy of every eval suite. See `src/recording-run.ts`. */
    recordingProxy?: { caCert: string; secret: string; url: string };
  }
}
