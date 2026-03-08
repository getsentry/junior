"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.withScope((scope) => {
      scope.setTag("event.name", "ui_global_error");
      scope.setContext("app", {
        "app.component": "global_error_boundary",
        "error.digest": error.digest ?? ""
      });
      Sentry.captureException(error);
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <h2>Something went wrong.</h2>
      </body>
    </html>
  );
}
