---
title: Security Hardening
description: Operator checklist for Junior authentication, credentials, and incident response.
type: conceptual
summary: Verify production security boundaries after deployment or during an incident.
prerequisites:
  - /concepts/security-and-authority/
related:
  - /concepts/credentials-and-oauth/
  - /reference/config-and-env/
  - /operate/reliability-runbooks/
---

Use this checklist after deployment and when investigating a security issue. Read [Security & Authority](/concepts/security-and-authority/) for the product model.

## Runtime

- User-influenced commands run in the sandbox.
- Long-lived secrets stay in host-managed storage.
- The host adds provider credentials only when a request needs them.
- OAuth links are private to the requesting user.
- Internal callbacks and sandbox identity are signed with a stable `JUNIOR_SECRET`.
- Plugins come from explicit app configuration, not dependency scanning.

## Credentials

- Only domains registered by a plugin can receive provider credentials.
- The sandbox receives placeholders, not reusable tokens.
- User access belongs to the current user or an exact task delegation.
- Rotating `JUNIOR_SECRET` invalidates pending callbacks and sandbox identity signed with the old value.
- Stored OAuth tokens are encrypted when `JUNIOR_ENCRYPTION_KEY_ID` is set. See [Token encryption](#token-encryption).

## Token encryption

Junior can encrypt stored OAuth tokens at rest with AES-256-GCM. Encryption is optional. Without keys, Junior stores tokens as plain text.

Generate a key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the same steps to turn on encryption and to rotate a key:

1. Add the key to `JUNIOR_ENCRYPTION_KEYS`, for example `k2:<new key>,k1:<old key>`. Deploy. Every deployment can now read values that use the key.
2. Set `JUNIOR_ENCRYPTION_KEY_ID` to the new key id. Deploy. New writes use the new key.
3. Wait for the credential sweep. It runs every 10 minutes at `/api/internal/credential-sweep` and re-encrypts stored tokens in small batches. Each run logs `credential_sweep.batch.completed`.
4. When the log shows `app.credential_sweep.last_clean_pass_at`, no stored token uses plain text or an old key. You can then remove the old key and deploy.

Do steps 1 and 2 in separate deploys. Otherwise, deployments that still run the old configuration cannot read tokens that new deployments write.

After you turn on encryption, do not roll back to a Junior release without encryption support. That release cannot read encrypted tokens.

If Junior cannot decrypt a stored token, it fails with an error that names the key id. It does not delete the token. Add the missing key back to fix it. Users can still unlink the account from App Home or with the slash command.

## Action Review

- Consequential actions can still enter review.
- Review failure blocks the action.
- Guardian telemetry does not contain raw proposals or secrets.

## Data

- Private transcripts are hidden from non-participants.
- Logs and traces exclude tokens, prompts, raw messages, and credential material.
- Retention and purge settings match company policy.

## Incident Response

1. Check logs, traces, and user-visible output for exposed tokens.
2. Confirm OAuth links were private and bound to the requesting user.
3. Confirm credentials were used only for the expected user and provider.
4. Confirm the sandbox did not receive reusable secrets.
5. Rotate exposed credentials, remove leaked material, and document the fix.

## Next Step

Validate deployment settings in [Config & Environment](/reference/config-and-env/). Use [Reliability Runbooks](/operate/reliability-runbooks/) if the incident is still active.
