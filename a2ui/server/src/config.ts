// Runtime configuration. Loads a2ui/.env (if present) once, before anything reads env.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScope } from "./log.js";

const logger = createScope("config");
const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts (tsx) and dist/config.js (build) both sit two levels below a2ui/.
const envPath = path.resolve(here, "../../.env");

let envLoaded = false;
try {
  process.loadEnvFile(envPath);
  envLoaded = true;
} catch {
  // No .env is fine: defaults + the `ant` CLI profile cover everything.
}

export type CredentialSource = "env:ANTHROPIC_API_KEY" | "env:ANTHROPIC_AUTH_TOKEN" | "ant-profile";

export const config = {
  model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
  effort: (process.env.ANTHROPIC_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max",
  port: Number(process.env.PORT || 8787),
  stream: (process.env.A2UI_STREAM ?? "1") !== "0",
  logLevel: process.env.LOG_LEVEL || "info",
  envFile: envLoaded ? envPath : null,
};

/** Label only — never the secret itself. */
export function credentialSource(): CredentialSource {
  if (process.env.ANTHROPIC_API_KEY) return "env:ANTHROPIC_API_KEY";
  if (process.env.ANTHROPIC_AUTH_TOKEN) return "env:ANTHROPIC_AUTH_TOKEN";
  return "ant-profile";
}

export function logConfig(): void {
  logger.info("resolved", { ...config, credentials: credentialSource() });
}
