# Cloudflare API Surface

## Code-mode pattern

The Cloudflare MCP uses a code-mode pattern. Always:

1. Call `search` with JavaScript that queries `spec.paths` to find the right endpoint.
2. Call `execute` with JavaScript that calls `cloudflare.request()` using the discovered path, method, and parameters.

**Example search:**

```javascript
Object.entries(spec.paths)
  .filter(([path]) => path.includes("/workers/scripts"))
  .map(([path, methods]) => ({ path, methods: Object.keys(methods) }));
```

**Example execute:**

```javascript
const accountId = params.account_id;
const result = await cloudflare.request({
  method: "GET",
  path: `/accounts/${accountId}/workers/scripts`,
});
return result.result?.map((s) => ({
  id: s.id,
  etag: s.etag,
  modified_on: s.modified_on,
}));
```

Pass `account_id` as an `execute` argument when the MCP server requires user-scoped account context.

## Key API areas for production operations

Do not treat this file as an endpoint catalog. Use it to choose search terms, then let the MCP `search` tool confirm the current path, method, parameters, and response shape.

| Area                      | Search for                                                                                       | Use when                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Account and token         | `tokens verify`, `accounts`, `audit logs`                                                        | Validate auth, discover accessible accounts, review recent account changes           |
| Zones                     | `zones`, `zone by name`                                                                          | Resolve a zone ID from a domain name or inspect zone status                          |
| Workers                   | `workers scripts`, `workers deployments`, `workers versions`, `workers settings`, `workers tail` | List Workers, inspect deploys, compare versions/settings, start diagnostic live logs |
| Workers Builds            | `builds`, `build logs`, `build status`                                                           | Find failed builds, inspect build metadata, summarize build logs                     |
| Analytics / Observability | `workers analytics`, `analytics queries`, `GraphQL Analytics`                                    | Check error rates, CPU time, request counts, and delayed analytics surfaces          |
| Logpush                   | `logpush jobs`, `logpush job status`                                                             | Check delivery health and recent delivery errors                                     |
| DNS                       | `dns records`, `dns record update`, `zone dns`                                                   | Inspect records, proxy status, TTLs, and prepare confirmed DNS changes               |
| Load Balancing            | `load balancer pools`, `pool health`, `monitors`                                                 | Check pool/origin health and monitor configuration                                   |
| Access / Zero Trust       | `access apps`, `tunnels`, `tunnel connections`, `gateway lists`                                  | Inspect Access apps, tunnel status, connector health, and Zero Trust resources       |
| WAF / Firewall            | `rulesets`, `firewall rules`, `waf`                                                              | Inspect or prepare confirmed rule changes                                            |
| Storage                   | `r2 buckets`, `kv namespaces`, `d1 database`                                                     | List and inspect storage resources; avoid destructive actions by default             |

Deep analytics may require Cloudflare's GraphQL Analytics API. Use `docs` to clarify the right dataset and query shape before executing GraphQL calls.

## Account and zone discovery order

1. Use `cloudflare.account-id` config if set.
2. If not set, search for the accounts list operation and execute it. If there is exactly one accessible account, use it.
3. If multiple accounts exist, ask the user to specify.
4. For zone ID: use `cloudflare.zone-id` config if set, else search for zone lookup by name and execute it with the requested domain.

## Dashboard deep links

Construct Cloudflare dashboard links from IDs:

- Account home: `https://dash.cloudflare.com/<account_id>`
- Workers: `https://dash.cloudflare.com/<account_id>/workers/services/view/<script_name>`
- Workers Builds: `https://dash.cloudflare.com/<account_id>/workers/builds`
- DNS: `https://dash.cloudflare.com/<account_id>/<zone_name>/dns/records`
- Load Balancers: `https://dash.cloudflare.com/<account_id>/load-balancing`
- Zero Trust: `https://one.dash.cloudflare.com/<account_id>/`
- Audit Log: `https://dash.cloudflare.com/<account_id>/audit-log`
