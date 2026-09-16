# Deploying for phone access

Claude's mobile apps can use a **remote** MCP server, so a deployed copy of this server
works from your phone. Two things to know before you start:

1. **Claude connects from Anthropic's cloud, not from your phone.** The server must be
   reachable over the public internet on HTTPS. A tunnel to your laptop works; so does a
   VPS. Something behind a VPN or a home firewall does not.
2. **You add the connector on [claude.ai](https://claude.ai) in a browser**, and it then
   syncs to the iOS and Android apps. You cannot add a new server from the phone itself.

> **Don't want a server at all?** The [ChatGPT Custom GPT route](README.md#chatgpt) needs
> no hosting and works on mobile today. It gives you 12 raw API operations instead of 17
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
- `https://your.domain/<token>/mcp` — the path form, for clients like the Claude connector
  UI that take only a URL.

`/health` stays open so uptime checks work without the token.

> The path form puts the secret in the URL, so it will appear in reverse-proxy access
> logs and is stored by whoever you give the URL to. Turn off URI logging (shown below)
> and rotate the token if it leaks. It is a rate-limit key, not a password to anything of
> yours.

## 2. Deploy with Docker Compose (recommended)

The release image is built for Linux amd64 and arm64. The supplied Compose definition
binds only to loopback, runs without Linux capabilities, uses a read-only root filesystem,
and refuses to start until a token is provided.

```bash
mkdir -p /opt/anteater-mcp
cd /opt/anteater-mcp
curl -O https://raw.githubusercontent.com/KKazuhaK/anteater-mcp/main/compose.yaml
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

Use `ANTEATER_MCP_IMAGE_TAG=v1.0.0` in `.env` to pin an immutable release instead of
tracking `latest`. Continue at [Terminate TLS](#5-terminate-tls) to expose it safely.
If the first pull asks you to authenticate, the repository owner has not yet changed the
new GHCR package from its initial private visibility to **Public**.

## 3. Install manually on the server

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin anteater
sudo -u anteater git clone https://github.com/KKazuhaK/anteater-mcp.git /home/anteater/anteater-mcp
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
fix that before going further.

## 5. Terminate TLS

**Caddy** gets a certificate on its own:

```caddyfile
mcp.example.com {
    # The token travels in the path, so keep it out of the access log.
    log {
        output file /var/log/caddy/anteater-mcp.log
        format filter {
            request>uri delete
        }
    }
    reverse_proxy 127.0.0.1:8787
}
```

**nginx**, if you already run it:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key from certbot

    access_log off;   # the token is in the URI

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE responses must not be buffered
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Check it from outside your network:

```bash
curl -s https://mcp.example.com/health
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
# expect 401 — the token is missing

curl -s -X POST https://mcp.example.com/<token>/mcp \
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
2. URL: `https://mcp.example.com/<token>/mcp`
3. Leave the OAuth fields empty — this server uses the token in the URL
4. Save, then confirm the 17 tools appear

Free accounts can have one custom connector; Pro and Max more.

Open the Claude app on your phone. The connector is already there, and the six prompts
show up alongside the tools. Try:

> *"What GE-2 courses are still open for Fall that end before 5pm, and which grades best?"*

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
