// Runs before any test file imports src/db — keeps tests off the dev database.
process.env.DB_PATH = ":memory:";
process.env.WORKSPACE_PATH = "/tmp/dream-test-workspace";
