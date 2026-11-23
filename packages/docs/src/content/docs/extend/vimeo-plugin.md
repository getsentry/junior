---
title: Vimeo Plugin
description: Upload private videos to a Vimeo folder with one shared Vimeo account.
type: tutorial
summary: Let Junior upload videos it renders to Vimeo as private, embed-only videos, and update their files and thumbnails.
prerequisites:
  - /extend/
related:
  - /extend/build-a-plugin/
  - /concepts/credentials-and-oauth/
---

Use the Vimeo plugin to put videos that Junior renders in its sandbox into a
Vimeo folder. A page then embeds the video instead of storing the file.

The plugin uses only a service account: an admin connects one Vimeo account
for the whole install. People never connect their own Vimeo accounts.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-vimeo
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { vimeoPlugin } from "@sentry/junior-vimeo";

export const plugins = defineJuniorPlugins([vimeoPlugin()]);
```

## Config

Set these variables in the Junior environment, then redeploy.

<details class="plugin-config">
<summary><code>VIMEO_CLIENT_ID</code>, <code>VIMEO_CLIENT_SECRET</code></summary>

Client ID and secret of a Vimeo API app.

- **Define:** Set both in the deployment environment
- **Required:** Yes

Create the app at [developer.vimeo.com](https://developer.vimeo.com/apps)
while signed in as the account that Junior will use. Add
`https://<your-domain>/api/service-accounts/vimeo/callback` to the app's
callback URLs.

</details>

<details class="plugin-config">
<summary><code>VIMEO_FOLDER_URI</code></summary>

The folder where Junior uploads, as `/users/<owner id>/projects/<folder id>`.
Junior changes only videos in this folder. A listing can name another
folder.

- **Define:** Set `VIMEO_FOLDER_URI` in the deployment environment
- **Required:** Yes, to upload, replace a file, or set a thumbnail

</details>

<details class="plugin-config">
<summary><code>VIMEO_EMBED_DOMAINS</code></summary>

Default hostnames where uploaded videos may be embedded, separated by commas,
such as `www.example.com,docs.example.com`. A call can name other hostnames.

- **Define:** Set `VIMEO_EMBED_DOMAINS` in the deployment environment
- **Required:** No. Without it, each upload must name its hostnames.

</details>

## Connect the account

1. Deploy with the variables above.
2. In the dashboard, open **Admin**, find **Vimeo** under **Service
   accounts**, and click **Connect**.
3. Sign in to Vimeo as the account that Junior uses, not as yourself, and
   allow access.

Vimeo tokens from this sign-in do not expire. To change the account, click
**Disconnect**, then connect again.

The `junior service-account connect` CLI does not work for Vimeo, because
Vimeo accepts only the callback URLs that the app lists.

### Team folders

To upload into a folder of a Vimeo team, add the Junior account to the team.
A team **Contributor** can create videos only in folders shared with it, so
share the folder with the Junior account with **Can manage**. Junior uploads
into the team owner's account, as Vimeo requires for team members.

## Privacy

Every requester shares one Vimeo account, so Junior uploads only into
`VIMEO_FOLDER_URI` and changes only videos in that folder. It refuses to
change any other video that the account can edit.

Vimeo applies these settings when it creates the video, before any bytes
arrive:

- Hidden from vimeo.com (`disable`, the default) or unlisted. No tool can make
  a video public.
- Embeddable only on the listed hostnames.
- Not downloadable, with comments and adding to showcases turned off.

Replacing a file keeps the video's ID, hash, privacy, and embed domains.

## Capabilities

| Tool                 | Does                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `vimeo_upload`       | Uploads a sandbox video in chunks and returns its ID and embed URL |
| `vimeo_replaceFile`  | Replaces the file of an existing video                           |
| `vimeo_setThumbnail` | Sets the active thumbnail from a JPEG or PNG                     |
| `vimeo_status`       | Returns upload and processing state, privacy, and embed URL      |
| `vimeo_listFolder`   | Lists the videos in a folder, newest first                       |

The tools read files from the sandbox on the host and accept only MP4, MOV,
and WebM videos up to 200 MB, and JPEG and PNG images up to 10 MB.

## Auth model

- Junior keeps the Vimeo token on the host and adds it only to the plugin's
  own API calls. The sandbox and the model never get it.
- Commands in the sandbox get no Vimeo credential.
- Until an admin connects the account, the tools fail with a message that
  says so.
