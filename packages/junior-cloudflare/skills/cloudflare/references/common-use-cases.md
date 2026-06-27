# Common Cloudflare Production Operations

## Investigate Worker errors after a deploy

1. List recent deployments to identify which version is live:
   - `GET /accounts/{id}/workers/scripts/{name}/deployments`
2. Check Worker analytics for error rate change after the deploy:
   - `GET /accounts/{id}/workers/analytics/queries` filtered by script name and time window covering the deploy
3. Check Worker tail/live logs if the script is still erroring:
   - Start a tail session via `POST /accounts/{id}/workers/scripts/{name}/tail`
4. Cross-reference with Sentry if errors are instrumented — hand off to the sentry skill for event details.

**Report:** current deployment version, error rate before/after deploy, sample error messages, and relevant Cloudflare dashboard link.

---

## Find latest failed Workers Build

1. List recent builds for the account:
   - `GET /accounts/{id}/builds?status=failed&per_page=5`
2. Get the failing build's details:
   - `GET /accounts/{id}/builds/{build_id}`
3. Fetch the build logs:
   - `GET /accounts/{id}/builds/{build_id}/logs`

**Report:** build ID, trigger (branch/commit), failure timestamp, error lines from build log, dashboard link.

---

## Query logs for a specific ray ID or error

1. Tail logs for the Worker in question (live or recent):
   - Start tail: `POST /accounts/{id}/workers/scripts/{name}/tail`
2. For Logpush (stored logs), check job health first:
   - `GET /accounts/{id}/logpush/jobs` or `GET /zones/{id}/logpush/jobs`
   - Look for `last_complete` and `last_error` fields to confirm delivery health
3. If the user has a ray ID (`CF-Ray` header value), it can be used to search stored logs in the configured destination (R2, S3, Splunk, etc.) — note this is outside Cloudflare's API surface.

---

## Check Logpush delivery health

1. List jobs:
   - `GET /accounts/{id}/logpush/jobs` or `GET /zones/{id}/logpush/jobs`
2. For each job, check:
   - `enabled`: whether the job is active
   - `last_complete`: last successful delivery timestamp
   - `last_error`: last error timestamp and message
   - `error_message`: most recent error detail
3. Flag jobs where `last_error` is more recent than `last_complete`.

**Report:** table of job names, destinations, enabled status, last complete, last error.

---

## Check DNS record and proxy status

1. Resolve zone ID from domain name:
   - `GET /zones?name=<domain>`
2. List DNS records (optionally filter by name or type):
   - `GET /zones/{id}/dns_records?name=<subdomain>&type=A`
3. For each relevant record, note:
   - `name`, `type`, `content` (IP/value), `ttl`, `proxied` (orange/grey cloud)
   - For MX records: `priority`
   - For TXT records: full content (SPF/DMARC)

**Caution:** Report what exists before suggesting changes. See `safety-and-permissions.md` before making DNS changes.

---

## Check load balancer pool health

1. List pools:
   - `GET /accounts/{id}/load_balancers/pools`
2. Get health for a specific pool:
   - `GET /accounts/{id}/load_balancers/pools/{pool_id}/health`
3. Check origins within the pool for `healthy` flag and failure counts.
4. Check associated monitors for their health check config:
   - `GET /accounts/{id}/load_balancers/monitors/{monitor_id}`

**Report:** pool name, total origins, healthy origin count, failing origins and their IPs, monitor type and expected response.

---

## Prepare a Worker rollback

**This is a write operation. Follow the safety workflow in `safety-and-permissions.md`.**

1. List deployments to find the rollback target:
   - `GET /accounts/{id}/workers/scripts/{name}/deployments`
2. Identify last known good deployment (by version tag, timestamp, or user input).
3. Compare compatibility date, bindings, routes, and env var metadata between current and target.
4. Show the proposed rollback: current version → target version, timestamp delta, any binding or config changes.
5. **Wait for explicit user approval.**
6. Deploy the target version:
   - `POST /accounts/{id}/workers/scripts/{name}/deployments` with the target version pinned
7. Monitor error rate and tail logs after rollback.

---

## Audit recent configuration changes

1. Fetch account audit log:
   - `GET /accounts/{id}/audit_logs?per_page=25`
2. Filter by actor, action type, or resource type relevant to the incident window.
3. For zone-level changes, also check zone-specific audit entries.

**Report:** timestamp, actor (user/API key), action, resource type/name, change summary.

---

## Inspect Zero Trust tunnel health

1. List tunnels:
   - `GET /accounts/{id}/access/tunnels`
2. Get tunnel details and connection status:
   - `GET /accounts/{id}/access/tunnels/{tunnel_id}`
   - `GET /accounts/{id}/access/tunnels/{tunnel_id}/connections`
3. Check `status` field: `healthy`, `degraded`, `inactive`, `down`.
4. Note the number of active connections and their originating connectors.

**Report:** tunnel name, status, connector count, edge locations connected, dashboard link.
