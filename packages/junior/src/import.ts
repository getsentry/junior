// Preload for a runtime that loads packages from `node_modules`, such as
// `nitro dev`: `node --import @sentry/junior/import`. Sentry instruments a
// package such as pi-ai when Node loads it, so its module hook must be
// registered before the app loads. `initSentry()` registers it too late,
// because its own modules load pi-ai. A production build does not need this,
// because the build instruments those packages.
import "@sentry/node/import";
