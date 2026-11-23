# @sentry/junior-vimeo

Private Vimeo uploads for Junior: upload sandbox videos into a Vimeo folder, replace their files and thumbnails, and check their processing. One shared Vimeo account, connected by an admin.

```bash
pnpm add @sentry/junior @sentry/junior-vimeo
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { vimeoPlugin } from "@sentry/junior-vimeo";

export const plugins = defineJuniorPlugins([vimeoPlugin()]);
```

Setup and configuration: https://junior.sentry.dev/extend/vimeo-plugin/
