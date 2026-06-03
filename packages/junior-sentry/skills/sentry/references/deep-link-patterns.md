# Sentry Deep Link Patterns

`{org}` = org slug, `{project_id}` = numeric project ID. All HTTPS.

## Issues

```
https://{org}.sentry.io/issues/?query=user.email:{email}
https://{org}.sentry.io/issues/{issue_id}/
```

## Replays

```
https://{org}.sentry.io/replays/?query=user.email:{email}
https://{org}.sentry.io/replays/{replay_id}/
```

## Explore

The Explore path is `explore/traces/`. There is NO `explore/spans/` route.

```
https://{org}.sentry.io/explore/traces/?mode=samples&project={project_id}&statsPeriod={stats_period}
https://{org}.sentry.io/explore/logs/?project={project_id}&statsPeriod={stats_period}
```

## Performance

```
https://{org}.sentry.io/performance/trace/{trace_id}/
```

Use `performance/trace/` for single trace-by-ID links. Use `explore/traces/` for search and filtered views.
