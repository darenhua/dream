// Bun auto-loads backend/.env; these are the only knobs outside the config table.

function flag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DB_PATH: process.env.DB_PATH ?? "./data/dream.db",
  WORKSPACE_PATH: process.env.WORKSPACE_PATH ?? "./workspace",

  // --- inference provider ---
  // true → AWS Bedrock (standard AWS credential chain: env vars, ~/.aws, SSO);
  // false → first-party Anthropic API via ANTHROPIC_API_KEY.
  USE_BEDROCK: flag("USE_BEDROCK"),
  AWS_REGION: process.env.AWS_REGION ?? "us-west-2",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",

  // --- outbound proxy ---
  // Bun's fetch honors HTTP(S)_PROXY from process.env at request time, so the
  // flag works by setting/clearing those vars below, before any client exists.
  USE_PROXY: flag("USE_PROXY"),
  PROXY_URL:
    process.env.PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    "",
};

// Apply the proxy flag to the process environment exactly once, at load.
// USE_PROXY=false must also *clear* inherited proxy vars (the user's shell
// exports a local proxy that otherwise captures all SDK traffic).
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
if (env.USE_PROXY && env.PROXY_URL) {
  for (const name of PROXY_VARS) process.env[name] = env.PROXY_URL;
} else {
  for (const name of PROXY_VARS) delete process.env[name];
}
