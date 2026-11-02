# Vercel plugin

- Tools return selected fields, never full deployment records, which can
  contain secrets.
- When a write response is lost, check provider state before a retry.
- Alias checks are not locks. An alias move does not prove which build
  handles later work.
- A valid webhook delivery never creates a watch.
