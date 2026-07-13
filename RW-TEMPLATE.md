# Deploy and Host Tailscale Subnet Router on Railway

A Tailscale subnet router connects your Railway project's private network to your tailnet. Deploy it as a service and every other service in the environment becomes reachable from your devices — `postgres.myapp-production-railway.internal:5432`, any port, TCP and UDP — without exposing anything publicly.

## About Hosting Tailscale Subnet Router

The container runs `tailscaled` in userspace-networking mode (no `/dev/net/tun` needed) and advertises the environment's private subnets — the IPv6 `/64`, plus private IPv4 ranges in dual-stack environments — detected at runtime from the route table, so nothing is hardcoded and the same image works in any project or environment. It also runs CoreDNS to serve a project-scoped DNS alias (`<project>-<env>-railway.internal`), letting multiple projects coexist on one tailnet. Configuration is a single required variable: a Tailscale auth key. New services become reachable the moment they deploy — no per-service setup.

## Common Use Cases

- Connect to Railway databases (Postgres, Redis, MySQL) from your laptop with real hostnames — no public endpoints, no TCP proxies, no SSH tunnels
- Reach internal admin panels, dashboards, and APIs that should never have a public domain
- Use Railway as an exit node (`TS_EXIT_NODE=true`) to route your traffic through Railway's network

## Dependencies for Tailscale Subnet Router Hosting

- A Tailscale account (free tier works) with MagicDNS enabled
- A Tailscale auth key: reusable, ephemeral, pre-authorized, and tagged (e.g. `tag:railway`)
- Railway private networking enabled in the environment (the default)

### Deployment Dependencies

- [Tailscale admin console](https://login.tailscale.com/admin) — create the auth key, set auto-approvers, add split DNS
- [Tailscale subnet router docs](https://tailscale.com/kb/1019/subnets)
- [Railway private networking docs](https://docs.railway.com/guides/private-networking)
- [Source repository](https://github.com/dotlouis/tailscale-rw)

### Implementation Details

One-time tailnet setup — auto-approve routes so redeploys (fresh ephemeral nodes) don't need manual approval:

```jsonc
"autoApprovers": {
  "routes": {
    "fd00::/8":   ["tag:railway"],
    "10.0.0.0/8": ["tag:railway"]   // dual-stack (post-Oct-2025) environments
  }
}
```

After deploying, the boot summary in the service logs prints the advertised routes and the exact split-DNS line to add in the admin console (DNS → Nameservers → Custom): `<project>-<env>-railway.internal` → the node's tailnet IP. Then, from any tailnet device:

```sh
psql 'postgres://user:pw@postgres.myapp-production-railway.internal:5432/railway'
curl http://my-api.myapp-production-railway.internal:8080/health
```

Optional variables: `TS_HOSTNAME` (tailnet hostname, defaults to the Railway service name), `TS_EXIT_NODE` (advertise as exit node), `TS_EXTRA_ROUTES` / `TS_SKIP_ROUTES` (adjust advertised CIDRs), `TS_DNS_ALIAS_SUFFIX` (override or disable the DNS alias). Attach a Railway volume at `/var/lib/tailscale` for a stable node identity and tailnet IP across redeploys.

## Why Deploy Tailscale Subnet Router on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Tailscale Subnet Router on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
