// Runs before any test file imports src/db — keeps tests off the dev database.
process.env.DB_PATH = ":memory:";
process.env.WORKSPACE_PATH = "/tmp/dream-test-workspace";
// Pin the process timezone to the configured TIMEZONE default (bun test would
// otherwise default TZ to UTC) so date math in tests (toLocaleDateString-built
// "today"s) agrees with todayLocal() on every machine at every hour — the
// suite runs in the user's real timezone, evenings included.
process.env.TZ = "America/Los_Angeles";
