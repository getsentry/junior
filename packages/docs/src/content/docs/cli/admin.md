---
title: "junior admin"
description: "Grant and revoke the Junior admin role."
type: reference
summary: Choose who can use admin-only setup in the Junior dashboard.
prerequisites:
  - /start-here/quickstart/
related:
  - /cli/upgrade/
  - /reference/config-and-env/
---

Use `junior admin` to choose who is a Junior admin. Admins see the **Admin**
page in the dashboard. Plugins put setup there that other people must not
use.

Only this command changes the admin role. The dashboard and Slack cannot change
it, so no one can make themselves an admin.

## Usage

Run the command from your Junior app with the production `DATABASE_URL`:

```bash
pnpm exec junior admin grant person@example.com
```

## Extended usage

```bash
# Show every admin
pnpm exec junior admin list

# Remove the admin role
pnpm exec junior admin revoke person@example.com
```

## What it does

`grant` sets the admin role on the Junior user with that email. If the person
has not used Junior yet, the command creates their user first. `revoke` removes
the role. `list` prints the email of every admin.

The change applies to the next dashboard request. The person does not need to
sign in again.

## Failure behavior

```text
No Junior user has the email "person@example.com".
```

`revoke` does not create users. Check the email and run `junior admin list`.

If the command reports a missing table or column, run
[`junior upgrade`](/cli/upgrade/) first.

## Verification

1. Run `pnpm exec junior admin list` and find the email.
2. Sign in to the dashboard as that person.
3. Open the profile menu and select **Admin**.

## Next step

Open the Admin page and finish any plugin setup listed there.
