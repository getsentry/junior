# Cloudflare API Surface

## Code-mode pattern

The Cloudflare MCP uses a code-mode pattern. Always:

1. Call `search` with JavaScript that queries `spec.paths` to find the right endpoint.
2. Call `execute` with JavaScript that calls `cloudflare.request()` using the discovered path, method, and parameters.

**Example search:**
```javascript
// Find Workers script list endpoint
Object.entries(spec.paths)
  .filter(([path]) => path.includes('/workers/scripts'))
  .map(([path, methods]) => ({ path, methods: Object.keys(methods) }))
```

**Example execute:**
```javascript
// List Worker scripts for an account
const result = await cloudflare.request('/accounts/{account_id}/workers/scripts', {
  method: 'GET',
  path: { account_id: 'YOUR_ACCOUNT_ID' },
});
return result.result?.map(s => ({ id: s.id, etag: s.etag, modified_on: s.modified_on }));
```

## Key API areas for production operations

### Workers

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/workers/scripts` | List all Worker scripts |
| `GET /accounts/{id}/workers/scripts/{name}` | Get a specific Worker script |
| `GET /accounts/{id}/workers/scripts/{name}/deployments` | List deployments (versions) |
| `POST /accounts/{id}/workers/scripts/{name}/deployments` | Create a new deployment (rollback: deploy old version) |
| `GET /accounts/{id}/workers/scripts/{name}/versions` | List script versions |
| `GET /accounts/{id}/workers/scripts/{name}/tail` | Start a tail session (live logs) |
| `GET /accounts/{id}/workers/scripts/{name}/settings` | Get script settings (bindings, env, compatibility) |
| `GET /accounts/{id}/workers/subdomain` | Get Workers dev subdomain |

### Workers Builds (CI)

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/builds` | List CI builds |
| `GET /accounts/{id}/builds/{build_id}` | Get a specific build |
| `GET /accounts/{id}/builds/{build_id}/logs` | Get build logs |

### Workers Analytics / Observability

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/workers/analytics/queries` | Query Worker analytics (error rates, CPU time) |
| `GET /zones/{id}/analytics/api/summary` | Zone-level analytics summary |

Note: Deep analytics may require the GraphQL Analytics API at `https://api.cloudflare.com/client/v4/graphql`. Use `docs` tool to clarify the right surface for specific metrics.

### Logpush

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/logpush/jobs` | List Logpush jobs for an account |
| `GET /accounts/{id}/logpush/jobs/{job_id}` | Get a specific Logpush job |
| `GET /zones/{id}/logpush/jobs` | List Logpush jobs for a zone |
| `GET /zones/{id}/logpush/jobs/{job_id}` | Get a specific Logpush job |

### DNS

| Endpoint pattern | What it does |
| --- | --- |
| `GET /zones` | List zones (use `?name=<domain>` to filter) |
| `GET /zones/{id}` | Get zone details |
| `GET /zones/{id}/dns_records` | List DNS records |
| `GET /zones/{id}/dns_records/{record_id}` | Get a specific DNS record |
| `POST /zones/{id}/dns_records` | Create a DNS record |
| `PATCH /zones/{id}/dns_records/{record_id}` | Update a DNS record |
| `DELETE /zones/{id}/dns_records/{record_id}` | Delete a DNS record |

### Load Balancers

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/load_balancers/pools` | List load balancer pools |
| `GET /accounts/{id}/load_balancers/pools/{pool_id}` | Get pool details |
| `GET /accounts/{id}/load_balancers/pools/{pool_id}/health` | Get pool health |
| `GET /accounts/{id}/load_balancers/monitors` | List health check monitors |
| `GET /zones/{id}/load_balancers` | List load balancers for a zone |

### Access / Zero Trust

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/access/apps` | List Access applications |
| `GET /accounts/{id}/access/tunnels` | List Cloudflare tunnels |
| `GET /accounts/{id}/access/tunnels/{tunnel_id}` | Get tunnel details |
| `GET /accounts/{id}/access/tunnels/{tunnel_id}/connections` | Get tunnel connections |
| `GET /accounts/{id}/gateway/lists` | List Zero Trust gateway lists |

### WAF / Firewall

| Endpoint pattern | What it does |
| --- | --- |
| `GET /zones/{id}/rulesets` | List WAF rulesets |
| `GET /zones/{id}/firewall/rules` | List firewall rules (legacy) |
| `GET /accounts/{id}/rulesets` | List account-level rulesets |

### Storage (R2, KV, D1)

| Endpoint pattern | What it does |
| --- | --- |
| `GET /accounts/{id}/r2/buckets` | List R2 buckets |
| `GET /accounts/{id}/storage/kv/namespaces` | List KV namespaces |
| `GET /accounts/{id}/d1/database` | List D1 databases |

### Account and token

| Endpoint pattern | What it does |
| --- | --- |
| `GET /user/tokens/verify` | Validate the current token |
| `GET /accounts` | List accessible accounts |
| `GET /accounts/{id}` | Get account details |
| `GET /accounts/{id}/audit_logs` | Get audit log (recent config changes) |

## Account and zone discovery order

1. Use `cloudflare.account-id` config if set.
2. If not set, call `/accounts` to list accessible accounts. If there is exactly one, use it.
3. If multiple accounts exist, ask the user to specify.
4. For zone ID: use `cloudflare.zone-id` config if set, else call `/zones?name=<zone_name>` to resolve by domain name.

## Dashboard deep links

Construct Cloudflare dashboard links from IDs:

- Account home: `https://dash.cloudflare.com/<account_id>`
- Workers: `https://dash.cloudflare.com/<account_id>/workers/services/view/<script_name>`
- Workers Builds: `https://dash.cloudflare.com/<account_id>/workers/builds`
- DNS: `https://dash.cloudflare.com/<account_id>/<zone_name>/dns/records`
- Load Balancers: `https://dash.cloudflare.com/<account_id>/load-balancing`
- Zero Trust: `https://one.dash.cloudflare.com/<account_id>/`
- Audit Log: `https://dash.cloudflare.com/<account_id>/audit-log`
