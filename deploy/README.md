# Vercel frontend + persistent server

The website and editor are static Vite output on Vercel. `/api/*` is an external
HTTPS rewrite to a persistent Node 22 API. Browser cookies stay on the frontend
origin. The server owns SQLite accounts, scenes, projects, contacts and Agent
provider credentials. The separately authenticated MCP process uses its own
SQLite database and the same scene renderer. Deploying only `dist/` supports
local editing/export, but does not provide accounts or hosted generation.

## Server preparation

Tested on CentOS Stream 9 with SELinux enforcing. Install Docker Engine and
Compose from the [official repository](https://docs.docker.com/engine/install/centos/),
Nginx, Python 3 and firewalld. Allow only SSH, HTTP and HTTPS; keep API 4419 and
MCP 4421 bound to loopback. On SELinux hosts enable `httpd_can_network_connect`.
Create a deployment user with an SSH key, verify a second login and sudo before
disabling password SSH. Keep existing services and firewall rules intact.

```sh
sudo install -d -m 0750 /opt/imstage/releases /etc/imstage /var/backups/imstage
sudo install -d -m 0750 -o 1000 -g 1000 /var/lib/imstage/api /var/lib/imstage/mcp
sudo install -d -m 0755 /var/www/acme
```

Create root-readable `/etc/imstage/api.env` (mode 0600):

```dotenv
IMSTAGE_APP_ORIGIN=https://your-frontend.example
DEEPSEEK_API_KEY=YOUR_PROVIDER_KEY
```

Optional image-provider variables are documented in [Agent configuration](../services/agent/README.md).
Never put these keys in `VITE_*`, Vercel client code, Git, or image build arguments.
Create `/etc/imstage/mcp.env` (mode 0600):

```dotenv
IMSTAGE_MCP_TOKEN=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
IMSTAGE_MCP_ALLOWED_HOSTS=api.example.com,127.0.0.1,localhost
```

Use `openssl rand -hex 32` to generate the token in a private setup session.
Clients connect to `https://api.example.com/mcp` with Bearer authentication.
Do not enable `IMSTAGE_MCP_PRIVATE_TUNNEL` on a public endpoint.

## Release and HTTPS

1. Export a reviewed Git commit into `/opt/imstage/releases/COMMIT` and build
   `docker build -f deploy/Dockerfile -t imstage:COMMIT .` from that directory.
   Docker installs Chromium and CJK fonts for deterministic server-side PNGs.
2. Run a database backup. Start `IMAGE_TAG=COMMIT docker compose -f deploy/compose.yaml up -d`.
   Verify `http://127.0.0.1:4419/api/health`, the API container health and an
   authenticated MCP create/render before updating `/opt/imstage/current`.
3. Obtain a trusted certificate using the ACME webroot `/var/www/acme`, then
   install `nginx.conf.example` with the actual hostname/certificate paths.
   Run `nginx -t` before reload. IP certificates are also supported by
   [Certbot 5.4+ and Let's Encrypt](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)
   using `--ip-address IP --preferred-profile shortlived`; these last six days,
   so automated renewal is essential. First serve the webroot over HTTP without
   a missing TLS certificate, issue the certificate, then enable the TLS block.
4. Install the four `systemd/` units into `/etc/systemd/system/`, run
   `systemctl daemon-reload` and `systemctl enable --now imstage-backup.timer imstage-cert-renew.timer`.
   Execute one backup and `certbot renew --dry-run` before relying on the timers.
5. Set the Vercel rewrite destination to the HTTPS backend; set
   `IMSTAGE_APP_ORIGIN` to the exact public frontend origin. Deploy `npm ci` /
   `npm run build` / `dist`. See [external rewrites](https://vercel.com/docs/routing/rewrites).
   Verify registration, cookie persistence across reload, logout/login, saved
   scene readback, an Agent stream and a real PNG download through the frontend.

The proxy overwrites `X-Real-IP`; the API trusts that single value only with
`IMSTAGE_TRUST_LOOPBACK_PROXY=1` and a loopback socket peer. Never expose the API
port publicly or trust arbitrary forwarding chains. Behind Vercel, its outgoing
proxy addresses can still aggregate users into an IP bucket; email/user limits
remain separate. This is an initial single-server deployment, not a globally
distributed identity service. Auth has no email verification/password recovery.

The Nginx body ceiling matches the Agent's 40 MiB contract; individual API routes
still apply smaller limits. Vercel imposes its own platform limits, so very large
attachments need end-to-end validation and can require a dedicated upload path.

## Backup, rollback and routine checks

`backup.py` copies each live SQLite database with SQLite's backup API and runs
`integrity_check`. This includes WAL state, scene data and MCP PNG blobs. It
retains 14 timestamped versions in `/var/backups/imstage`. These are **same-host
backups**; off-host disaster recovery still needs a chosen storage destination.
Treat backups as sensitive user data. Do not commit or publish them.

Before each release, record the old image tag and back up. To roll back compatible
code, run Compose from the old release with its old `IMAGE_TAG`; the persistent
volumes stay in place. Never run `down -v` for production. If a future release
changes schema incompatibly, stop writers and restore a verified pre-release
backup first; code rollback alone is insufficient.

Useful checks: `docker compose ps`, bounded `docker compose logs --tail 100`,
`systemctl list-timers 'imstage-*'`, `journalctl -u imstage-cert-renew --since today`,
`df -h`, database backup integrity and external `/api/health`. A health response
alone does not prove provider credentials, saving, image generation or MCP.

## Adding the final domain

Use an apex or `www` hostname for the Vercel frontend, and `api` for this server.
Add the frontend domain in Vercel and use the exact DNS records Vercel gives for
that project. Point the API hostname's A record to the server (AAAA only if IPv6
is configured). Issue its certificate, add the host to MCP allowed hosts, update
Nginx and the rewrite, then change the API's exact frontend origin. Verify TLS,
login/save and redirects before retiring old URLs. DNS changes require the actual
domain and DNS provider; neither is guessed here.
