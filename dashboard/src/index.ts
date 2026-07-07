import { serve } from "bun";
import index from "./index.html";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3001";

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    // Same-origin proxy to the dream backend — no CORS, prod parity.
    "/api/*": async req => {
      const url = new URL(req.url);
      const target = new URL(url.pathname + url.search, BACKEND);
      return fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Dashboard running at ${server.url} (API → ${BACKEND})`);
