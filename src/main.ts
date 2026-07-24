/**
 * Process entrypoint.
 *
 * Binds the port the platform hands us (`PORT`), on all interfaces in production because the
 * container's port must be reachable from outside it, and on loopback otherwise so a local run is
 * not exposed to the network.
 */

import { createApp } from "./api/app.ts";
import { isProduction } from "./config/environment.ts";
import { loadSettings } from "./config/settings.ts";

async function main(): Promise<void> {
  const settings = loadSettings();
  const app = await createApp({ settings });
  const port = Number(process.env["PORT"] ?? 8000);
  const host = isProduction(settings.environment) ? "0.0.0.0" : "127.0.0.1";

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port, host });
}

await main();
