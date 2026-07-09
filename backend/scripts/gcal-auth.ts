// One-time Google Calendar OAuth helper (run on the EC2 box, or anywhere with
// the same .env + DB): prints the consent URL, catches the loopback redirect
// on :8765, exchanges the code, and persists the refresh token.
//
//   cd /srv/dream/backend && bun run scripts/gcal-auth.ts
//
// From a laptop, SSH-forward the loopback first:
//   ssh -L 8765:localhost:8765 <ec2> then open the printed URL locally.
//
// Fallback (no forwarding): open the URL anywhere, let the localhost redirect
// fail, copy the `code` query param from the address bar, and POST it:
//   curl -X POST localhost:3001/api/calendar/auth/token -d '{"code":"..."}'
import { consentUrl, exchangeCode } from "../src/services/google/auth";
import { ensureDreamCalendar } from "../src/services/calendarSync";

const url = consentUrl();
console.log("\nOpen this URL in a browser:\n");
console.log(url);
console.log("\nWaiting for the redirect on http://localhost:8765/callback ...\n");

const server = Bun.serve({
  port: 8765,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
    const code = u.searchParams.get("code");
    if (!code) return new Response(`consent failed: ${u.searchParams.get("error") ?? "no code"}`, { status: 400 });
    try {
      await exchangeCode(code);
      const calendarId = await ensureDreamCalendar();
      setTimeout(() => {
        server.stop();
        process.exit(0);
      }, 100);
      console.log(`connected — dream calendar: ${calendarId}`);
      return new Response("dream is connected to google calendar. you can close this tab.");
    } catch (e) {
      console.error(e);
      return new Response(`token exchange failed: ${e instanceof Error ? e.message : e}`, { status: 500 });
    }
  },
});
