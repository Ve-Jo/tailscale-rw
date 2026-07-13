# Railway Tailscale Services (Raycast extension)

Browse every Railway service reachable over your tailnet through a
[tailscale-rw](../README.md) subnet router, and jump to its private URL —
`⏎` opens `http://<svc>.<project>-<env>-railway.internal:<port>` in the browser,
with copy actions for the host, `host:port`, and (for databases) a paste-ready
connection string rewritten to the tailnet hostname.

## How it works

- Lists your Railway projects via the public GraphQL API (read-only).
- Keeps only environments that contain a tailscale-rw router (detected by
  `tailscale` in the service name / repo / image; among lookalikes, the one
  carrying a `TAILSCALE_AUTHKEY` wins). A preference can show the rest too.
- Hostnames come from each service's `RAILWAY_PRIVATE_DOMAIN` (private DNS
  names don't follow renames) plus the alias suffix the router *actually*
  serves: its `TS_DNS_ALIAS_SUFFIX` if set (`none` → plain `railway.internal`),
  else the default `<project>-<env>-railway.internal`.
- Ports are best-effort: `RAILWAY_TCP_APPLICATION_PORT` / `PORT` /
  `PGPORT`-style variables first, then defaults for known images
  (postgres → 5432, redis → 6379, …). Unknown ports get a `port?` tag and the
  browser action falls back to port 80.

## Install (local development mode)

```sh
cd raycast
npm install
npm run dev   # imports the extension into Raycast and opens it
```

After the first `npm run dev` the extension stays installed; stop the dev
server whenever. Then set the one required preference:

- **Railway API Token** — create one at
  [railway.com/account/tokens](https://railway.com/account/tokens). An account
  token covers all your workspaces; a project/team token limits the view
  accordingly. Used read-only.

## Notes

- The `variables` API response is used to read `RAILWAY_PRIVATE_DOMAIN`, port
  hints and the private connection URL; results are cached locally by Raycast.
- Reachability still depends on the one-time tailnet setup (routes approved,
  split DNS for the alias suffix) — see the [main README](../README.md).
