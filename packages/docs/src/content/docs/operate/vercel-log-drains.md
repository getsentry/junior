---
title: Vercel Log Drains
description: Forward Vercel runtime, build, and edge logs to Sentry using Vercel's built-in log drain.
type: tutorial
summary: Configure a Vercel log or trace drain pointed at Sentry's ingestion endpoint to route Vercel output into Sentry Logs and Traces.
prerequisites:
  - /start-here/deploy-to-vercel/
  - /operate/observability/
related:
  - /extend/sentry-plugin/
  - /operate/observability/
  - /operate/reliability-runbooks/
---

Vercel Drains let you forward telemetry from your Vercel-hosted Junior deployment directly to Sentry without modifying application code. Sentry receives the data as [Logs](https://docs.sentry.io/product/explore/logs/) and [Traces](https://docs.sentry.io/product/explore/trace-explorer/).

Official references:

- [Sentry Vercel Drains documentation](https://docs.sentry.io/product/drains/vercel/)
- [Vercel Drains documentation](https://vercel.com/docs/drains)

## Prerequisites

- Vercel **Pro or higher** plan (drains require Pro or Enterprise)
- A deployed Junior project on Vercel
- A Sentry project to receive the data

## Automatic setup (Sentry native integration)

If you installed Junior from the [Sentry Vercel Integration](https://vercel.com/marketplace/sentry) and created a new Sentry account during that flow, you can add drains directly from the integration settings:

1. From the Vercel dashboard, open the **Integrations** tab.
2. Select **Sentry** from the list, click **Manage**, and select your installed product.
3. Under **Drains**, click **Add Drain**.
4. Choose which Vercel project to drain from, then click **Create Drain**.

> **Note:** Automatic drain setup is only available with the Native Integration when a _new_ Sentry account was created during install. For existing Sentry accounts, follow the manual steps below.

## Manual setup

Manual setup applies to any Sentry account. You need the Sentry ingestion endpoint and auth header from your project's DSN settings.

### Locate the Sentry endpoint and auth header

1. In Sentry, go to **Settings > Projects > \[your project\] > Client Keys (DSN)**.
2. Expand the **Vercel** section.
3. Copy the **Vercel Log Drain Endpoint** URL and the **Authentication Header** value (`x-sentry-auth: sentry sentry_key=<key>`).

### Create the log drain in Vercel

1. From the Vercel dashboard, go to **Team Settings > Drains** and click **Add Drain**.
2. Select **Logs** as the data type.
3. Name the drain and select the project(s) to drain from.
4. Set the **Sampling rate**. Start at 100% to confirm delivery, then reduce as needed.
5. Select the **Log sources** to collect. See [Log sources](#log-sources) below.
6. Select which **Environments** to drain (production, preview, or all).
7. Under the **Custom Endpoint** tab:
   - **URL**: paste the Vercel Log Drain Endpoint from Sentry.
   - **Format**: choose **JSON** or **NDJSON** (both are accepted).
   - Enable **Custom Headers** and add one header per line:
     ```
     x-sentry-auth: sentry sentry_key=<your-public-key>
     ```
8. Click **Create Drain**. Vercel tests the endpoint automatically on save.

### Verify log drain delivery

After creating the drain, click **Test** from the drain settings. Then check [Sentry Logs](https://sentry.io/explore/logs/) to confirm entries are arriving.

## Trace drain setup

Trace drains forward OpenTelemetry (OTLP) distributed tracing data from Vercel Functions to Sentry.

1. From the Vercel dashboard, go to **Team Settings > Drains > Add Drain**.
2. Select **Traces** as the data type.
3. Name the drain, select projects, and configure the sampling rate.
4. Under the **Custom Endpoint** tab:
   - **URL**: from Sentry **Settings > Projects > \[your project\] > Client Keys (DSN) > OpenTelemetry (OTLP)**, copy the **OTLP Traces Endpoint**.
   - Enable **Custom Headers** and add:
     ```
     x-sentry-auth: sentry sentry_key=<your-public-key>
     ```
     (Find this value under the same **OTLP Traces Endpoint Headers** section.)
5. Click **Create Drain**.

Vercel sends trace data over OTLP/HTTP (JSON or Protobuf). OTLP/gRPC is not supported by Vercel drains.

## Log sources

Vercel surfaces six log source categories. Select the ones relevant to your deployment:

| Source | What it captures |
| --- | --- |
| **Functions** | Output from Vercel Functions (API Routes) |
| **Edge Functions** | Output from Edge runtime functions and Middleware |
| **Static Files** | Requests for static assets (HTML, CSS, etc.) |
| **Rewrites** | External rewrite results to a different domain |
| **Builds** | Output from the Vercel build step |
| **Firewall** | Requests denied by Vercel Firewall rules |

## Caveats

- **Metric drains not supported.** Speed Insights and Web Analytics cannot be forwarded to Sentry. See [GitHub issue #103488](https://github.com/getsentry/sentry/issues/103488) if you need this.
- **Empty messages on `static`/`edge` logs.** Some logs from these sources intentionally have an empty `message` field per the Vercel schema. This is expected.
- **Static source logs in Sentry only.** Logs with `source: static` show up in Sentry but not in the Vercel dashboard by default; that is a Vercel dashboard display limitation.
- **Build logs are not trace-connected.** Vercel build logs are forwarded but do not carry trace context. Use `vercel.project_name`, `vercel.deployment_id`, and `vercel.build_id` attributes to correlate build logs with a specific deployment.
- **Trace correlation for runtime logs.** When [Vercel Tracing](https://vercel.com/docs/tracing) is active, runtime logs during traced requests are automatically enriched with `traceId` and `spanId` fields at no extra configuration cost.

## Next step

Use [Observability](/operate/observability/) to build queries against the ingested logs and traces, and [Reliability Runbooks](/operate/reliability-runbooks/) for symptom-driven response playbooks.
