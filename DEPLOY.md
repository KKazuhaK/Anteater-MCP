# Deploying for phone access

Claude's mobile apps can use a **remote** MCP server, so a deployed copy of this server
works from your phone. Two things to know before you start:

1. **Claude connects from Anthropic's cloud, not from your phone.** The server must be
   reachable over the public internet on HTTPS. A tunnel to your laptop works; so does a
   VPS. Something behind a VPN or a home firewall does not.
2. **You add the connector on [claude.ai](https://claude.ai) in a browser**, and it then
   syncs to the iOS and Android apps. You cannot add a new server from the phone itself.

> **Don't want a server at all?** The [ChatGPT Custom GPT route](README.md#chatgpt) needs
> no hosting and works on mobile today. It gives you 12 raw API operations instead of 19
> tools, and no prerequisite or conflict checking, but it is free and takes five minutes.

---

## What you are exposing

This server is read-only over public UCI data, so a leaked endpoint does not expose
anything private. The real consequences are that someone else can **burn your Anteater API
rate limit**, and that an open endpoint is an open proxy. That is worth a token, not worth
an OAuth server.

---

## 1. Generate a token

```bash
openssl rand -hex 24
```

Set it as `ANTEATER_MCP_TOKEN`. With it set, the HTTP transport accepts a request only if
it carries the token, as either:

- `Authorization: Bearer <token>` — use this wherever you can set headers, and
- `https://your.domain/mcp?token=<token>` — for clients that accept only a URL.

**Prefer the header wherever the client allows one.** Claude's connector dialog has a
*Request headers* section, so the token does not have to go in the URL there.

`/health` stays open so uptime checks work without the token.

> The query form still puts the secret in the URL, so it may appear in browser history,
> reverse-proxy access logs, and stored connector settings. Turn off URI logging (shown
> below) and rotate the token if it leaks.

## 2. Deploy with Docker Compose (recommended)

The supplied Compose definition binds only to loopback, runs without Linux capabilities,
uses a read-only root filesystem, and refuses to start until a token is provided.

> **The published image only exists once a release is tagged.** `ghcr.io/kkazuhak/anteater-mcp`
> is built and pushed by the release workflow, which runs on a `v*` tag. If no release has
> been cut yet, `docker compose up` fails with `manifest unknown` — use
> [Build the image yourself](#build-the-image-yourself) below, or tag a release first.

```bash
mkdir -p /opt/anteater-mcp
cd /opt/anteater-mcp
curl -O https://raw.githubusercontent.com/KKazuhaK/Anteater-MCP/main/compose.yaml
cat > .env <<EOF
ANTEATER_MCP_TOKEN=$(openssl rand -hex 24)
ANTEATER_API_KEY=<your optional Anteater API key>
EOF
chmod 600 .env
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/health
```

Update without changing configuration:

```bash
docker compose pull
docker compose up -d
```

Use `ANTEATER_MCP_IMAGE_TAG=v0.0.7` in `.env` to pin an immutable release instead of
tracking `latest`. Continue at [Put it behind TLS](#5-put-it-behind-tls) to expose it safely.
If the first pull asks you to authenticate, the repository owner has not yet changed the
new GHCR package from its initial private visibility to **Public**.

### Build the image yourself

Works with no release published, and is also what you want for a fork. The image is one
file plus a base layer, so this takes seconds.

```bash
git clone https://github.com/KKazuhaK/Anteater-MCP.git /opt/anteater-mcp-src
cd /opt/anteater-mcp-src
docker build -t anteater-mcp:local .

cd /opt/anteater-mcp
# point Compose at the local tag instead of the registry
echo "ANTEATER_MCP_IMAGE=anteater-mcp:local" >> .env
docker compose up -d
```

For that to take effect, `compose.yaml` reads `ANTEATER_MCP_IMAGE`; set
`pull_policy: never` too if you want Compose to refuse to reach the registry at all.

### Cutting the release that produces the image

```bash
npm run check:version          # package.json and the server must agree
git tag v0.0.7 && git push origin v0.0.7
```

The release workflow validates the tag against the package version, rebuilds the test
gates, produces the standalone binaries, and pushes the container image. Afterwards, make
the new GHCR package **Public** in the repository's package settings — it is private by
default, and a private package is why a first pull would ask you to log in.

## 3. Install manually on the server

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin anteater
sudo -u anteater git clone https://github.com/KKazuhaK/Anteater-MCP.git /home/anteater/anteater-mcp
node -v   # must be Node 24 LTS
```

No `npm install` is needed to run the source — the server has no runtime dependencies.

Put the secrets in a root-owned file that the service reads:

```bash
sudo install -m 600 -o root -g root /dev/null /etc/anteater-mcp.env
sudo tee /etc/anteater-mcp.env >/dev/null <<'EOF'
ANTEATER_MCP_TOKEN=<the token you generated>
ANTEATER_API_KEY=<your Anteater API secret key>
EOF
```

## 4. Run it under systemd

`/etc/systemd/system/anteater-mcp.service`:

```ini
[Unit]
Description=Anteater MCP server
After=network-online.target
Wants=network-online.target

[Service]
User=anteater
WorkingDirectory=/home/anteater/anteater-mcp
EnvironmentFile=/etc/anteater-mcp.env
# Bind loopback only and let the reverse proxy terminate TLS. There is no reason
# for this process to listen on a public interface.
ExecStart=/usr/bin/node anteater-mcp.mjs --http --host 127.0.0.1 --port 8787
Restart=always
RestartSec=5

# It only needs outbound HTTPS and its own read-only source tree.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now anteater-mcp
sudo systemctl status anteater-mcp
curl -s localhost:8787/health
```

The startup log tells you whether auth is on. If it warns that no token is set, stop and
fix that before going further. Each HTTP exchange then produces structured
`http.request` and `http.response` JSON lines. The application redacts URL tokens and
does not log Authorization values or RPC arguments. Reverse-proxy logs are separate and
must still be disabled or redacted when URL authentication is used.

## 5. Put it behind TLS

Use whatever you already run. The server speaks plain HTTP on loopback and does not care
what fronts it — it only has to satisfy five requirements, because of SSE and because a
URL-only client sends the token in the query string.

| Requirement | Why | If you get it wrong |
|---|---|---|
| **Do not buffer responses** | `GET /mcp` is a Server-Sent Events stream, and `POST /mcp` returns SSE when the client asks for it | The client hangs waiting for a response the proxy is holding |
| **Read timeout above 25 seconds**, 300s is comfortable | The SSE stream sends a keepalive comment every 25s and is otherwise silent | The proxy drops the stream mid-conversation |
| **HTTP/1.1 upstream** | Chunked responses and keep-alive | Streaming breaks; nginx in particular defaults to 1.0 |
| **Pass the complete request target through unchanged** | URL-only clients use `/mcp?token=<token>` | Every request 401s |
| **Do not add an `Origin` header** | The server validates `Origin` when one is present, and allows requests without one, which is what Claude and ChatGPT send | A proxy-injected origin gets 403 |

Two more things that are not requirements but you want them: **keep the URI out of access
logs**, since the token may be in it, and let the proxy hold the certificate so the server
never sees one.

### Seeing the real client address

A proxied request arrives from the proxy, so by default the log records the proxy — inside
Docker that is the bridge gateway, typically `172.x.x.x`, for every request. The client is
in `X-Forwarded-For`, but that header is set by whoever sent the request, so the server
ignores it until you name the peers allowed to set it:

```bash
# in .env, alongside the token
ANTEATER_TRUSTED_PROXIES=private       # covers the Docker bridge and the RFC1918 ranges
```

Use `loopback` when the server runs directly on the host, or list exact CIDRs
(`172.21.0.0/16,10.8.0.0/24`) to be strict. With it set, the log reports the real client as
`remote` and keeps the proxy as `via`, and the generated `/openapi.json` picks up the
external hostname from `X-Forwarded-Host` instead of reporting `localhost`.

Make sure the proxy actually sends the headers — the nginx block above sets
`X-Forwarded-Proto`; add the client address too:

```nginx
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
```

<details open><summary><b>nginx</b></summary>

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key from certbot

    access_log off;                      # a URL token is in the request URI

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;          # required for streaming
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;             # required for SSE
        proxy_cache off;
        proxy_read_timeout 300s;         # keepalives are 25s apart
    }
}
```
</details>

<details><summary><b>Caddy</b></summary>

```caddyfile
mcp.example.com {
    log {
        output file /var/log/caddy/anteater-mcp.log
        format filter {
            request>uri delete           # a URL token is in the request URI
        }
    }
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1                # never buffer, for SSE
    }
}
```
</details>

<details><summary><b>Traefik</b>, if it already fronts your Compose stack</summary>

Add to the `server` service in `compose.yaml`, and drop the `ports:` mapping so only
Traefik reaches it:

```yaml
    labels:
      traefik.enable: "true"
      traefik.http.routers.anteater.rule: Host(`mcp.example.com`)
      traefik.http.routers.anteater.entrypoints: websecure
      traefik.http.routers.anteater.tls.certresolver: myresolver
      traefik.http.services.anteater.loadbalancer.server.port: "8787"
      # Traefik does not buffer by default; do not add a buffering middleware here.
```
</details>

<details><summary><b>Cloudflare Tunnel</b>, no open ports at all</summary>

```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8787
    originRequest:
      disableChunkedEncoding: false      # leave chunking on, for SSE
  - service: http_status:404
```

Proxied Cloudflare hostnames buffer some responses; if a stream stalls, set the route to
**DNS only**, or use one of the proxies above instead.
</details>

Check it from outside your network:

```bash
curl -s https://mcp.example.com/health
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# expect 401 — the token is missing

curl -s -X POST 'https://mcp.example.com/mcp?token=<token>' \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# expect {"jsonrpc":"2.0","id":1,"result":{}}
```

### Optional: restrict to Anthropic

Since only Anthropic's cloud needs to reach this, you can narrow it further by allowing
only their egress ranges on port 443. The current list is published at
<https://docs.claude.com/en/api/ip-addresses> — read it at deploy time rather than copying
ranges from here, because they change. Note that this also blocks your own `curl` checks
and any other MCP client you use from a laptop.

## 6. Add it to Claude

On **claude.ai in a browser** (not the phone):

1. **Settings → Connectors → Add custom connector**
2. URL: `https://mcp.example.com/mcp` — no token in the URL
3. Leave **No sign-in** selected. Claude warns that anyone with the URL could then use
   the connector, which is exactly what the next step answers.
4. Under **Request headers**, add `Authorization` = `Bearer <your token>`. Claude stores
   header values encrypted and never displays them again.
5. Save, then confirm the 19 tools appear

Putting the token in a header rather than the URL keeps it out of your reverse proxy's
access log and out of the stored connector URL. For clients with no header field:

```
https://mcp.example.com/mcp?token=<token>
```

Free accounts can have one custom connector; Pro and Max more.

Open the Claude app on your phone. The connector is already there, and the six prompts
show up alongside the tools. Try:

> *"What GE-2 courses are still open for Fall that end before 5pm, and which grades best?"*

### The same endpoint from ChatGPT and Codex

One deployment serves all three. Only the dialog differs.

**ChatGPT on the web** — Settings → Connectors → create, or the New Plugin dialog:

```
Server URL:     https://mcp.example.com/mcp
Authentication: Access token / API key
Header scheme:  Bearer
Token:          <your token>
```

**ChatGPT on a phone** — MCP plugins are web-only, so the phone needs a Custom GPT
pointed at the REST facade instead. Fetch the generated document and paste it into the
Action editor:

```bash
curl -s -H "Authorization: Bearer <your token>" https://mcp.example.com/openapi.json
```

In the GPT editor: **Create new action → paste the schema →
Authentication: API Key → Auth Type: Bearer → paste the token.** The `servers` URL is
filled in from the request, so it already points at your deployment. All tools are
available, formatted exactly as the MCP side returns them.

Note that OpenAI is retiring Custom GPTs (Dec 11 2026 for affected workspaces) in favour
of plugins. When plugins reach mobile, switch back to the MCP endpoint — the server needs
no change, since both surfaces are generated from the same tool definitions.

**Codex** — reads the token from the environment, so it never reaches a config file:

```bash
export ANTEATER_MCP_TOKEN=...
codex mcp add anteater --url https://mcp.example.com/mcp --bearer-token-env-var ANTEATER_MCP_TOKEN
```

## 7. Keeping it current

```bash
sudo -u anteater git -C /home/anteater/anteater-mcp pull
sudo systemctl restart anteater-mcp
```

Nothing to rebuild. When UCI's API changes and results start looking wrong, work from
[UPSTREAM.md](UPSTREAM.md), which records exactly what this was validated against.

---

## Lighter alternatives

**A tunnel, no VPS.** Fine for trying it out; the URL changes each restart on free tiers,
and the connector has to be updated each time.

```bash
ANTEATER_MCP_TOKEN=$(openssl rand -hex 24) node anteater-mcp.mjs --http &
cloudflared tunnel --url http://localhost:8787     # or: ngrok http 8787
```

**Desktop only.** If you only want it on a computer, skip all of this and use the stdio
transport — see [Installing](README.md#installing). No server, no token, no TLS.

---

## AGPL and deployment

This server is AGPL-3.0-or-later. Running an **unmodified** copy carries no extra
obligation. If you modify it and let other people use your instance over the network,
section 13 requires you to offer them your modified source. The server already advertises
where its source lives, at `/health` and `/source` — if you deploy a fork, point the
`SOURCE_URL` constant in `anteater-mcp.mjs` at your repository so that offer is true.
