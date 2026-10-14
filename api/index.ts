import type { IncomingMessage, ServerResponse } from "http";
import { createApp } from "../src/app";
import { connectDatabase } from "../src/config/db";

/**
 * Vercel serverless entry point. The app previously only had a `server.ts`
 * that calls `app.listen()` — meaningless on a platform with no persistent
 * process, and with no exported request handler for Vercel's Node runtime
 * to invoke, every request crashed with FUNCTION_INVOCATION_FAILED before
 * even reaching Express's router. `server.ts` remains the entry point for
 * local dev (`npm run dev`) and is untouched.
 *
 * The DB connection is cached across warm invocations (Vercel reuses the
 * same container for consecutive requests) instead of reconnecting on
 * every call.
 */
const app = createApp();

let connectionPromise: Promise<void> | null = null;
function ensureDbConnection(): Promise<void> {
  if (!connectionPromise) {
    connectionPromise = connectDatabase().catch((error: unknown) => {
      connectionPromise = null; // allow the next invocation to retry instead of staying permanently broken
      throw error;
    });
  }
  return connectionPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ensureDbConnection();
  app(req, res);
}
