---
title: Vimeo Plugin
description: Upload private videos to Vimeo folders with one shared Vimeo account.
type: tutorial
summary: Let Junior upload videos it renders to Vimeo as private, embed-only videos, and update their files and thumbnails.
prerequisites:
  - /extend/
related:
  - /extend/build-a-plugin/
  - /concepts/credentials-and-oauth/
---

Use the Vimeo plugin to put videos that Junior renders in its sandbox into
Vimeo folders. A page then embeds the video instead of storing the file. Each
upload names its folder, so each channel or use case can use a different
folder.

The plugin uses only a service account: an admin connects one Vimeo account
for the whole install. People never connect their own Vimeo accounts.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-vimeo
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { vimeoPlugin } from "@sentry/junior-vimeo";

export const plugins = defineJuniorPlugins([
  vimeoPlugin({ embedDomains: ["www.example.com"] }),
]);
```

## Config

Pass the default embed domains to `vimeoPlugin()`. Set the client ID and
secret in the Junior environment, then redeploy.

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
<summary><code>embedDomains</code></summary>

Default hostnames where uploaded videos may be embedded, such as
`["www.example.com", "docs.example.com"]`. A call can name other hostnames.
Vimeo does not extend `example.com` to its subdomains, so list each hostname
that embeds the video.

- **Define:** Pass `embedDomains` to `vimeoPlugin()`
- **Required:** No. Without it, each upload must name its hostnames.

</details>

## Connect the account

1. Deploy with the config above.
2. In the dashboard, open **Admin**, find **Vimeo** under **Service
   accounts**, and click **Connect**.
3. Sign in to Vimeo as the account that Junior uses, not as yourself, and
   allow access.

Vimeo tokens from this sign-in do not expire. To change the account, click
**Disconnect**, then connect again.

The `junior service-account connect` CLI does not work for Vimeo, because
Vimeo accepts only the callback URLs that the app lists.

## Folders

Each upload and folder listing names its folder, as the API URI
`/users/<owner id>/projects/<folder id>` or the vimeo.com link
`https://vimeo.com/user/<owner id>/folder/<folder id>`. `vimeo_listFolders`
lists the folders that the account owns. Give it a team owner's user ID to
list the team folders that the account can reach.

### Team folders

To upload into a folder of a Vimeo team, add the Junior account to the team.
A team **Contributor** can create videos only in folders shared with it, so
share the folder with the Junior account with **Can manage**. Junior uploads
into the team owner's account, as Vimeo requires for team members.

## Privacy

Every requester shares one Vimeo account. Junior can read and change any
video that the account can reach, and it can upload into any folder that the
account can reach. Give the account access only to the folders that Junior
may use.

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
| `vimeo_listFolders`  | Lists the folders that the account can reach                     |

The tools read files from the sandbox on the host and accept only MP4, MOV,
and WebM videos up to 200 MB, and JPEG and PNG images up to 10 MB.

## Auth model

- Junior keeps the Vimeo token on the host and adds it only to the plugin's
  own API calls. The sandbox and the model never get it.
- Commands in the sandbox get no Vimeo credential.
- Until an admin connects the account, the tools fail with a message that
  says so.
