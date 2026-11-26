# @sentry/junior-vimeo

Private Vimeo uploads for Junior: list the Vimeo folders the account can reach, upload sandbox videos into the folder that each call names, replace their files and thumbnails, and check their processing. One shared Vimeo account, connected by an admin.

```bash
pnpm add @sentry/junior @sentry/junior-vimeo
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { vimeoPlugin } from "@sentry/junior-vimeo";

export const plugins = defineJuniorPlugins([
  vimeoPlugin({ embedDomains: ["www.example.com"] }),
]);
```

Setup and configuration: https://junior.sentry.dev/extend/vimeo-plugin/
