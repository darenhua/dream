// Bun auto-loads backend/.env; these are the only knobs outside the config table.
export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  DB_PATH: process.env.DB_PATH ?? "./data/dream.db",
  WORKSPACE_PATH: process.env.WORKSPACE_PATH ?? "./workspace",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
};
