import * as Sentry from '@sentry/nextjs';

declare function register(): Promise<void>;
declare const onRequestError: typeof Sentry.captureRequestError;

export { onRequestError, register };
