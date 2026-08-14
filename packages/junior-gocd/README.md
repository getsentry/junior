# @sentry/junior-gocd

`@sentry/junior-gocd` adds generic read-only GoCD tools to Junior.

This package is host-agnostic:

- tools call GoCD through `ctx.egress.fetch`
- Junior injects host-managed auth headers at egress
- deploy topology and private host defaults stay out of this package

## Install

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { gocdPlugin } from "@sentry/junior-gocd";

export const plugins = defineJuniorPlugins([
  gocdPlugin({
    // Optional. You can also set GOCD_URL in the host environment.
    baseUrl: "https://gocd.example.com",
  }),
]);
```

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `GOCD_URL` | when `baseUrl` is omitted | Absolute https GoCD origin, for example `https://gocd.example.com` |
| `GOCD_ACCESS_TOKEN` | for the default bearer path | Read-only GoCD API token. Injected by Junior as `Authorization: bearer ...` |

### Static bearer headers

When you pass only `baseUrl` / `GOCD_URL`, the plugin declares:

- `domains: [<host>]`
- `apiHeaders.Authorization: bearer ${GOCD_ACCESS_TOKEN}`

### Host credential hooks

Hosts that need extra headers (for example Google IAP `Proxy-Authorization`)
should pass `hooks.grantForEgress` and `hooks.issueCredential`. In that mode the
plugin keeps `domains` and omits static `apiHeaders`, matching Junior's egress
credential contract. Keep private proxy defaults and service-account names in
the host app, not this package.

```ts
gocdPlugin({
  baseUrl: "https://gocd.example.com",
  hooks: {
    grantForEgress() {
      return {
        access: "read",
        name: "gocd-read",
        reason: "read-only GoCD API access",
      };
    },
    async issueCredential() {
      // Mint short-lived header transforms for owned domains.
      return {
        type: "lease",
        lease: {
          expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "gocd.example.com",
              headers: {
                Authorization: "bearer ...",
                "Proxy-Authorization": "Bearer ...",
              },
            },
          ],
        },
      };
    },
  },
});
```

## Tools

- `pipelineHistory`: recent runs for one exact pipeline name

API usage is checked against GoCD **25.2.0**:

- bearer auth: `Authorization: bearer <token>`
- history: `GET /go/api/pipelines/:name/history` with `Accept: application/vnd.go.cd.v1+json`
- `page_size` clamped to 10..100 per server rules

## Notes

Register this package from the host app that owns your GoCD deployment. Keep
environment-specific pipeline names, regions, and deploy topology in host
skills or private plugins.
