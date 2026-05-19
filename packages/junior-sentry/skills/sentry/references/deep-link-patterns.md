# Sentry Deep Link Patterns

Generate these URLs to link users directly to Sentry web UI views. Replace `{org}`, `{email}`, `{issue_id}`, etc. with actual values.

## Issues

### Issues by user email

```
https://{org}.sentry.io/issues/?query=user.email:{email}
```

### Single issue

```
https://{org}.sentry.io/issues/{issue_id}/
```

## Replays

### Replays by user email

```
https://{org}.sentry.io/replays/?query=user.email:{email}
```

### Single replay

```
https://{org}.sentry.io/replays/{replay_id}/
```

## Explore

### Traces explorer

Use this for linking to filtered trace views in the Explore section.

```
https://{org}.sentry.io/explore/traces/?mode=samples&project={project_id}&statsPeriod={stats_period}
```

- `mode`: `samples` (individual traces) or `aggregate`.
- `project`: Sentry project ID (numeric).
- `statsPeriod`: Time range such as `30d`, `14d`, `24h`.
- Additional query filters can be appended, for example `&query=gen_ai.conversation.id:"value"`.

> **Important**: The correct path segment is `explore/traces/`, NOT `explore/spans/`. There is no `/explore/spans/` route in the Sentry web UI.

### Logs explorer

```
https://{org}.sentry.io/explore/logs/?project={project_id}&statsPeriod={stats_period}
```

## Performance

### Trace detail

Use this for linking to a specific trace by ID.

```
https://{org}.sentry.io/performance/trace/{trace_id}/
```

## Notes

- `{org}` is the Sentry organization slug (e.g., `sentry` for sentry.sentry.io).
- `{project_id}` is the numeric Sentry project ID.
- `{email}` should be URL-encoded if it contains special characters.
- All URLs use HTTPS.
- Prefer `explore/traces/` for search and filtered views. Use `performance/trace/{trace_id}/` only for direct trace-by-ID links.
