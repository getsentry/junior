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

## Performance

### Trace

```
https://{org}.sentry.io/performance/trace/{trace_id}/
```

## Notes

- `{org}` is the Sentry organization slug (e.g., `getsentry`).
- `{email}` should be URL-encoded if it contains special characters.
- All URLs use HTTPS.
