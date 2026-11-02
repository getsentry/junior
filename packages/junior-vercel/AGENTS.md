# Vercel plugin

- `JUNIOR_VERCEL_TOKEN` stays on the host. The sandbox gets only a placeholder
  `VERCEL_TOKEN`. The host adds the `Authorization` header.
- Tools return selected fields, not full deployment records, which can
  contain secrets.
- When a write response is lost, check provider state before a retry.
- Alias checks are not locks. An alias move does not prove which build
  handles later work.
- A valid webhook delivery never creates a watch. Unmatched deliveries are not
  replayed.
- `deployment.error` maps to the same outcome as GitHub `deployment.failed`.
