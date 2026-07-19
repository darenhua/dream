# Deploy — VM git-poller CI/CD

Single-user, self-contained continuous deployment. No GitHub secrets, no
inbound access to the VM, no Actions runner. A systemd timer polls the public
GitHub repo; when `main` advances it gates on typecheck + tests and redeploys
the backend + MCP in place. Migrations apply automatically at process start.

## Topology

```
GitHub main ──poll (git fetch)──▶ VM checkout ~/deployments/dream-coach-git
                                    │ gate: bunx tsc --noEmit && bun test
                                    ▼
                        systemd: dream-coach.service (Bun+Hono, 127.0.0.1:8130)
                                    ▲
        Caddy (auto-TLS, Let's Encrypt)  https://100-48-129-170.nip.io
          ├─ /mcp            creator MCP (public; one-time dashboard codes)
          ├─ /companion-mcp  companion MCP (fail-closed; hashed bearer token)
          └─ /api/*          dashboard API (Vercel frontend rewrites here)

Vercel (frontend) ── /api/* rewrite ──▶ https://100-48-129-170.nip.io/api/*
```

iMessage/spectrum-kit stays **dark on the VM** (Linux can't send iMessages).
The messaging transport is the mock until a local macOS daemon is wired; see
the root `deployment.md` "Gotchas".

## Files

| file | purpose |
|---|---|
| `dream-coach.service` | systemd unit: runs `bun run serve` on 8130, bound to loopback |
| `dream-coach-poll.sh` | the poller: fetch → if main moved, pull + gate + restart + health |
| `dream-coach-poll.service` + `.timer` | run the poller every 3 minutes |
| `Caddyfile.dream` | TLS vhost for the nip.io host → 127.0.0.1:8130 |
| `vm-bootstrap.sh` | one-time: clone, install units, Caddy vhost, enable timer |

## One-time bootstrap

```sh
# on the VM, after `main` has the feature merged:
curl -fsSL https://raw.githubusercontent.com/darenhua/dream/main/deploy/vm-bootstrap.sh | bash
```

(or `scp` this dir up and run `bash deploy/vm-bootstrap.sh`). It is idempotent.

## Secrets

Backend env lives at `~/deployments/.secrets/dream-coach/secrets.env` (seeded
2026-07-15) plus the MCP-public additions the bootstrap appends idempotently:

```
BIND_HOST=127.0.0.1
MCP_PUBLIC_URL=https://100-48-129-170.nip.io
MCP_ALLOWED_HOSTS=100-48-129-170.nip.io
MCP_TRUST_PROXY=true
# companion (single-user): hash only; the plaintext token is written once to
# ~/deployments/.secrets/dream-coach/companion-token.txt (chmod 600).
COMPANION_AUTH_TOKEN_SHA256=<sha256>
```

The creator MCP needs no standing token — it authorizes via the expiring
one-time codes the dashboard issues. The companion token gates `/companion-mcp`
only; retrieve the plaintext from the token file to configure an MCP client.
