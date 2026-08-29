# @sentry/junior-gocd

`@sentry/junior-gocd` adds read-only GoCD tools to Junior. The package does not contain settings for a specific GoCD deployment.

## Install

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { gocdPlugin } from "@sentry/junior-gocd";

export const plugins = defineJuniorPlugins([
  gocdPlugin({
    // Optional. You can set GOCD_URL instead.
    baseUrl: "https://gocd.example.com",
  }),
]);
```

## Configuration

| Variable            | Required                  | Use                                                                 |
| ------------------- | ------------------------- | ------------------------------------------------------------------- |
| `GOCD_URL`          | when `baseUrl` is omitted | The HTTPS base URL for GoCD, such as `https://gocd.example.com`     |
| `GOCD_ACCESS_TOKEN` | for token authentication  | A read-only GoCD API token used as the `Authorization` bearer token |

The configured base URL cannot change during a tool call. Junior allows network access and adds credentials for the domain when it registers the plugin.

For services such as Google IAP, the app can supply `grantForEgress` and `issueCredential` hooks instead of `GOCD_ACCESS_TOKEN`:

```ts
gocdPlugin({
  baseUrl: "https://gocd.example.com",
  hooks: {
    grantForEgress() {
      return {
        access: "read",
        name: "gocd-read",
        reason: "read GoCD data",
      };
    },
    async issueCredential() {
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

- `pipelineHistory`: returns recent runs for one pipeline
- `stage`: returns one stage run, its jobs, and failed job names

The tools use the GoCD 25.2.0 API:

- pipeline history: `GET /go/api/pipelines/:name/history` with `Accept: application/vnd.go.cd.v1+json`
- stage run: `GET /go/api/stages/:pipeline_name/:stage_name/instance/:pipeline_counter/:stage_counter` with `Accept: application/vnd.go.cd.v3+json`
- pipeline history limits `page_size` to 10 through 100

Keep pipeline names and other deployment-specific settings in the app that registers this plugin.
