import { afterAll, afterEach, beforeAll } from "vitest";
import { mswServer, rejectUnhandledExternalRequest } from "./msw";

beforeAll(() => {
  mswServer.listen({
    onUnhandledRequest(request) {
      rejectUnhandledExternalRequest(request);
    },
  });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});
