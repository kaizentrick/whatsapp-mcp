# Deployment and operations

## Docker

`docker compose up -d --build` builds the repository and runs one service as UID
1000 with a read-only root filesystem, a private data volume and a small temporary
filesystem. No database server, browser or message broker is needed.

Use the generated owner key locally:

```sh
docker compose exec whatsapp-mcp cat /data/admin.token
```

Account credentials for agents can be created while the service is running:

```sh
docker compose exec whatsapp-mcp node dist/cli.js token:create \
  --account Sales --permissions read,send --days 30 --out /data/sales.token
docker compose cp whatsapp-mcp:/data/sales.token ./sales.token
chmod 600 sales.token
```

The command prints the credential ID and expiry, never the credential itself.
Copy the file privately to the agent host. Revoke by its ID:

```sh
docker compose exec whatsapp-mcp node dist/cli.js token:revoke --id TOKEN_ID
```

Revoking an account key also invalidates OAuth grants derived from it on the next
authenticated request. Logout invalidates that account's keys through a new
credential epoch. Create new account keys after pairing again.

## HTTPS or a private connection

For an SSH connection, keep the default loopback binding:

```sh
ssh -N -L 8787:127.0.0.1:8787 your-user@your-server
```

Then browse `http://127.0.0.1:8787`. Stdio/Bearer clients can also use this forward.
For remote OAuth clients use a stable public HTTPS origin.

For HTTPS with Caddy, use [examples/Caddyfile](../examples/Caddyfile), point DNS
to the server and set the exact origin before starting:

```sh
WA_PUBLIC_URL=https://whatsapp.example.com docker compose up -d --build
```

An existing Cloudflare Tunnel can forward the same origin to
`http://127.0.0.1:8787`. If cloudflared runs in a separate container, place both
services on a private Docker network and forward to `http://whatsapp-mcp:8787`.
Route the **whole origin**, including `/mcp`, `/authorize`, `/token`, `/register`,
`/revoke`, `/oauth/consent` and `/.well-known/*`. Interactive access screens in
front of `/mcp` can prevent server-side agents from connecting.

The application trusts one reverse proxy for rate limiting. Keep the application
port private and have the proxy replace forwarded headers. Authenticated browser
API requests must have the configured same origin; arbitrary cross-origin browser
requests are denied. Server-side agents do not need CORS.

## Environment

| Setting | Default | Meaning |
| --- | --- | --- |
| `WA_DATA_DIR` | XDG directory, `/data` in Docker | Private persistent state |
| `WA_HOST` | `127.0.0.1`, `0.0.0.0` in Docker | Listener binding |
| `WA_PORT` | `8787` | Listener port |
| `WA_PUBLIC_URL` | `http://127.0.0.1:8787` | Exact external origin, HTTPS remotely |
| `WA_MAX_MEDIA_BYTES` | `5242880` | Upload/download limit, up to 25 MiB |
| `WA_AUTO_START` | `true` | Resume accounts previously started; `false` disables startup resume |
| `WA_MASTER_KEY` | private `master.key` | Optional 64 hexadecimal character encryption key |
| `WA_ADMIN_TOKEN` | private `admin.token` | Optional owner access key, minimum 32 characters |
| `WA_SERVER_URL` | loopback port 8787 | Stdio bridge server origin |
| `WA_CLIENT_TOKEN_FILE` | `admin.token` | Stdio bridge credential file |
| `WA_CLIENT_TOKEN` | unset | Optional bridge Bearer credential; prefer a private file |

Run `init` once before source/systemd deployment. Existing key files are never
overwritten. Keep files private (0600) and the data directory private (0700).
Prefer the generated files over environment secrets. Never commit session data,
credentials, QR payloads or production backups.

## systemd

Install Node 24+, build under `/opt/whatsapp-mcp`, create a dedicated
`whatsapp-mcp` OS user and `/var/lib/whatsapp-mcp` owned by it (0700). Run
`WA_DATA_DIR=/var/lib/whatsapp-mcp node /opt/whatsapp-mcp/dist/cli.js init` as that
user. Adapt and install [the example unit](../examples/whatsapp-mcp.service),
including the actual Node path and HTTPS origin. Start and enable the unit.

## Persistence, backups and upgrades

The service stores `whatsapp.sqlite`, `oauth.sqlite`, their WAL files,
`master.key` and `admin.token` in its data directory. Credential slots, raw
message records and OAuth records are authenticated encrypted. Message text,
account identities, contacts, chats and receipt indexes are searchable plaintext
inside the private SQLite database. Use full-disk encryption when required. An
attacker who obtains the complete volume and its key files can decrypt it.

Stop the service cleanly before copying the **entire data directory or volume**
to an encrypted, access-controlled backup. Include both keys and all SQLite/WAL
files. Restart promptly and verify `/health` and account status. Do not run two
services against copies of the same paired session. A writer lease fences two
services using the same live SQLite file; it cannot fence separate copied disks.

Upgrade by reviewing the release notes, backing up, checking out the target tag
and rebuilding. Preserve the volume. Do not use `docker compose down -v` for an
upgrade. A stale restored Signal session may be incompatible with its remote
cryptographic state; recovery can require linking a fresh device by QR.

`/health` is a minimal unauthenticated process/writer check. Per-account state and
synchronization information require authentication. An `open` socket does not
prove complete history, message delivery or unlimited future availability.

SQLite is intended for a single server with a local disk. Do not share this
volume across replicas or mount its WAL database on a network filesystem.
