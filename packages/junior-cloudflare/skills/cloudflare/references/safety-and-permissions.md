# Safety and Permissions

## Write operations requiring explicit confirmation

**Never execute the following without fetching current state, showing a before/after summary, and receiving explicit user approval:**

| Category            | Requires confirmation                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Workers             | Deploy (new version), rollback, route create/update/delete, script delete, env var/secret change |
| DNS                 | Record create, update, delete (any type — A, AAAA, CNAME, MX, TXT, SRV)                          |
| Load Balancers      | Pool create/update/delete, monitor create/update/delete, LB failover                             |
| WAF / Firewall      | Rule create, update, disable, delete; ruleset deploy                                             |
| Access / Zero Trust | App policy change, tunnel create/delete, connector restart                                       |
| Logpush             | Job enable/disable, destination change, job delete                                               |
| Storage             | R2 bucket delete, KV namespace delete, D1 database drop; **no destructive ops by default**       |
| Account             | API token create/delete, member add/remove                                                       |

## Pre-write checklist

Before executing any state-changing API call:

1. **Identify the resource exactly.** Confirm account ID, zone ID, resource name, and resource ID.
2. **Fetch current state.** Use a `GET` call to show what exists now.
3. **State the intended change.** Name the Cloudflare operation, method, and the exact fields that will change.
4. **Summarize impact.** What breaks if this fails? Is there a rollback path?
5. **Ask for approval.** Do not proceed until the user explicitly confirms.
6. **Execute and verify.** After the write, confirm the new state with a follow-up `GET`.

## Rollback runbook

1. Search for Workers script deployments and list recent deployments.
2. Identify target (last known good version by timestamp or user input).
3. Diff compatibility date, bindings metadata, routes, and cron triggers between current and target.
4. Confirm the rollback target with the user — include version tag, deploy timestamp, and any config deltas.
5. Search for the current deployment operation, then execute it with the target version pinned.
6. Verify: check tail logs and analytics for error rate stabilization.

## DNS change safety

- Always fetch the existing record by name and type before modifying.
- Show full current record: name, type, content, TTL, proxied status, priority (if MX).
- Warn on apex (`@`) records — TTL and CNAME flattening can affect zone behavior.
- Warn on DMARC (`_dmarc`), SPF (TXT on root), and DKIM records — changes can break email delivery.
- Confirm zone ID matches the user's intended domain — zone names can be ambiguous in multi-zone accounts.
- Do not delete records by ID without showing the full record content first.

## Recommended API token permission sets

Suggest least-privilege tokens. Do not request or use an all-powerful token by default.

| Task                                        | Minimum token permissions                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Read-only ops (monitoring, logs, analytics) | Account Resources: Read, Zone: Read, Workers Scripts: Read, Logs: Read, Analytics: Read |
| Worker deploy / rollback                    | Workers Scripts: Edit (add Workers Routes: Edit if routes change)                       |
| DNS management                              | DNS: Edit, Zone: Read                                                                   |
| Load balancer management                    | Load Balancers: Edit, Zone: Read                                                        |
| Logpush job management                      | Logs: Edit                                                                              |
| Zero Trust / Access                         | Access: Edit, Zero Trust: Edit                                                          |
| R2 / KV / D1 read-only                      | corresponding Read scopes only                                                          |

When the user's token lacks required permissions, stop and explain what permission is needed rather than attempting workarounds.

## Sensitive data redaction

- Do not print Worker script source code in responses.
- Do not print env var values, secrets, or binding credentials.
- Do not print full authorization headers, cookies, or tokens from log samples.
- For log bodies and HTTP payloads, print only a short representative sample (1–3 lines) and summarize the pattern.
- For DNS records, printing record values is fine (they are public) — but flag if a TXT record appears to contain a secret.
