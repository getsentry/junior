# Junior Test Harness

- No per-test MSW servers. Do not mock the Slack SDK for outbound contract
  tests.
- Every `completeObject` schema must pass `strictProviderSchemaProblems` in
  its owning unit test. The gateway reports strict-schema errors only at
  request time.
- Keep Vitest file parallelism. Database isolation is per worker.
- S3 storage tests need `docker compose up -d s3` from the repo root.
