import { createApp } from "./app";
import { connectDatabase } from "./config/db";
import { env } from "./config/env";
import { runActivityLogRetentionSweep } from "./services/activity-log-retention.service";

const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT}`);
  });

  void runActivityLogRetentionSweep();
  setInterval(() => void runActivityLogRetentionSweep(), RETENTION_SWEEP_INTERVAL_MS);
}

main().catch((error: unknown) => {
  console.error("[server] failed to start:", error);
  process.exit(1);
});
