// Google Calendar OAuth helper. The API server itself hosts the callback
// (GET /api/calendar/oauth/callback), so the normal path is just the admin
// dashboard's "connect google calendar" button. This script only prints the
// consent URL for headless/remote setups.
//
//   bun run scripts/gcal-auth.ts     (backend server must be running)
//
// Remote (VM): forward the port first so the redirect reaches the server —
//   ssh -L 3001:localhost:3001 vm
// — then open the printed URL locally. No forwarding? Let the redirect fail,
// copy the `code` query param, and paste it into the admin Calendar panel
// (or: curl -X POST localhost:3001/api/calendar/auth/token -d '{"code":"..."}').
import { consentUrl, LOOPBACK_REDIRECT } from "../src/services/google/auth";

console.log("\nOpen this URL in a browser (the running API server completes the flow):\n");
console.log(consentUrl());
console.log(`\nThe redirect lands on ${LOOPBACK_REDIRECT} — make sure the backend is running.`);
