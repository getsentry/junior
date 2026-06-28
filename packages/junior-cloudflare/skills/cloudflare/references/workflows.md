# Cloudflare Workflows

## Investigate Worker errors after a deploy

1. List recent deployments to identify which version is live:
   - Search for Workers script deployments, then execute the current list operation.
2. Check Worker analytics for error rate change after the deploy:
   - Search for Workers analytics queries and filter by script name and time window covering the deploy.
3. Check Worker tail/live logs if the script is still erroring:
   - Search for Workers tail or live logs and start a diagnostic tail session if available.
4. Cross-reference with Sentry if errors are instrumented — hand off to the sentry skill for event details.

**Report:** current deployment version, error rate before/after deploy, sample error messages, and relevant Cloudflare dashboard link.

---

## Find latest failed Workers Build

1. List recent builds for the account:
   - Search for Workers Builds list operations and filter for failed or recent builds.
2. Get the failing build's details:
   - Search for the build detail operation using the build ID.
3. Fetch the build logs:
   - Search for build log retrieval and execute it only for the relevant build.

**Report:** build ID, trigger (branch/commit), failure timestamp, error lines from build log, dashboard link.

---

## Query logs for a specific ray ID or error

1. Tail logs for the Worker in question (live or recent):
   - Search for Workers tail or live logs and start a diagnostic tail session if available.
2. For Logpush (stored logs), check job health first:
   - Search for account-level or zone-level Logpush jobs.
   - Look for `last_complete` and `last_error` fields to confirm delivery health
3. If the user has a ray ID (`CF-Ray` header value), it can be used to search stored logs in the configured destination (R2, S3, Splunk, etc.) — note this is outside Cloudflare's API surface.

---

## Check Logpush delivery health

1. List jobs:
   - Search for account-level or zone-level Logpush jobs.
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
   - Search for zone lookup by name and execute it with the requested domain.
2. List DNS records (optionally filter by name or type):
   - Search for DNS record list/filter operations and constrain by record name or type.
3. For each relevant record, note:
   - `name`, `type`, `content` (IP/value), `ttl`, `proxied` (orange/grey cloud)
   - For MX records: `priority`
   - For TXT records: full content (SPF/DMARC)

**Caution:** Report what exists before suggesting changes. See `safety-and-permissions.md` before making DNS changes.

---

## Check load balancer pool health

1. List pools:
   - Search for load balancer pool list operations.
2. Get health for a specific pool:
   - Search for pool health operations.
3. Check origins within the pool for `healthy` flag and failure counts.
4. Check associated monitors for their health check config:
   - Search for load balancer monitor detail operations.

**Report:** pool name, total origins, healthy origin count, failing origins and their IPs, monitor type and expected response.

---

## Prepare a Worker rollback

**This is a write operation. Follow the safety workflow in `safety-and-permissions.md`.**

1. List deployments to find the rollback target:
   - Search for Workers script deployments and list recent versions/deployments.
2. Identify last known good deployment (by version tag, timestamp, or user input).
3. Compare compatibility date, bindings, routes, and env var metadata between current and target.
4. Show the proposed rollback: current version → target version, timestamp delta, any binding or config changes.
5. **Wait for explicit user approval.**
6. Deploy the target version:
   - Search for the current Worker deployment operation and execute it with the target version pinned.
7. Monitor error rate and tail logs after rollback.

---

## Audit recent configuration changes

1. Fetch account audit log:
   - Search for account audit logs and fetch a bounded recent page.
2. Filter by actor, action type, or resource type relevant to the incident window.
3. For zone-level changes, also check zone-specific audit entries.

**Report:** timestamp, actor (user/API key), action, resource type/name, change summary.

---

## Inspect Zero Trust tunnel health

1. List tunnels:
   - Search for Access or Zero Trust tunnel list operations.
2. Get tunnel details and connection status:
   - Search for tunnel detail and tunnel connection operations.
3. Check `status` field: `healthy`, `degraded`, `inactive`, `down`.
4. Note the number of active connections and their originating connectors.

**Report:** tunnel name, status, connector count, edge locations connected, dashboard link.
