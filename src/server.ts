import { createApp } from "./app";
import { connectDatabase } from "./config/db";
import { env } from "./config/env";

async function main(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT}`);
  });
}

main().catch((error: unknown) => {
  console.error("[server] failed to start:", error);
  process.exit(1);
});
