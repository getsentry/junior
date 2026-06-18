# GoCD REST API Reference (Read-Only)

The read endpoints this skill uses. Auth (a GoCD bearer token plus a Google IAP token) is injected by the Junior runtime at the egress proxy; the script sends no credentials itself.

## Dashboard

```
GET /go/api/dashboard
Accept: application/vnd.go.cd.v4+json
```

The whole server in one call: `_embedded.pipeline_groups[]` (`name` plus a list of pipeline name strings) and `_embedded.pipelines[]`, each with `locked`, `pause_info` (`{paused, paused_by, pause_reason, paused_at}`), and `_embedded.instances[]` for the latest run (`counter`, `scheduled_at`, and `_embedded.stages[]` with `status`). Powers `status <group>`, `paused`, and group resolution. Readable by any viewer (no admin role).

Field-name traps vs the per-pipeline status endpoint: the pause reason is `pause_reason` here but `paused_cause` on `/status`; timestamps are ISO-8601 strings here, epoch milliseconds elsewhere; the dashboard has no `schedulable` field.

## Pipeline history (paginated)

```
GET /go/api/pipelines/{name}/history?page_size=N
Accept: application/vnd.go.cd.v1+json
```

`page_size` has a server-side minimum of 10 — smaller values return HTTP 404, so clamp to 10 and slice client-side. Each run has `name`, `counter`, `scheduled_date` (epoch ms), `build_cause.material_revisions[]` (git SHAs and pipeline dependencies), and `stages[]`. Stage `status`: `Building`, `Passed`, `Failed`, `Unknown`. Job `result`: `Passed`, `Failed`.

## Pipeline status

```
GET /go/api/pipelines/{name}/status
Accept: application/vnd.go.cd.v1+json
```

`{paused, paused_cause, paused_by, locked, schedulable}`. A pipeline is actively running when `locked: true`.

## Stage instance

```
GET /go/api/stages/{pipeline}/{pipeline_counter}/{stage}/{stage_counter}
Accept: application/vnd.go.cd.v3+json
```

Detailed jobs including `job_state_transitions` timestamps: `Scheduled`, `Assigned`, `Preparing`, `Building`, `Completing`, `Completed`.

## Job console log

```
GET /go/files/{pipeline}/{counter}/{stage}/{stage_counter}/{job}/cruise-output/console.log
```

Plain text, no Accept header. Logs older than ~30 days are archived to GCS and deleted from disk — those return HTTP 404 (the `failures` command reports this as `log_status: "archived"`; fall back to the GoCD web UI).
