# WhatsApp MCP

Self-host your WhatsApp accounts and connect them to agents through standard MCP.
Pair each number with a QR. Read chats, contacts, messages and groups. Send text
or attachments from an explicitly selected account, including to yourself and to
WhatsApp numbers that are absent from your contacts.

[Español](docs/es.md) · [Deployment](docs/deployment.md) ·
[Agent connections](docs/clients.md) · [Tools](docs/tools.md) ·
[Architecture](docs/architecture.md) · [Roadmap and migration](docs/ROADMAP.md)

This is an independent TypeScript application using Baileys directly. It does
not require Evolution API, Redis, PostgreSQL, Chromium, an AI API key or a
particular AI provider. One persistent service owns the WhatsApp sockets; many
agents connect to it. A small web page handles accounts and QR pairing.

**Status: v0.1, experimental.** Automated integration tests use a simulated
WhatsApp transport. An optional network smoke test verifies that the real
transport receives a QR. Actual phone pairing, bidirectional delivery and device
restart continuity must be verified on each deployment. Tests of another backend
do not establish those results for this one.

## Quick start with Docker

Requires Git and Docker Engine with Compose on your own server.

```sh
git clone https://github.com/kaizentrick/whatsapp-mcp.git
cd whatsapp-mcp
docker compose up -d --build
docker compose exec whatsapp-mcp cat /data/admin.token
```

Open <http://127.0.0.1:8787> on that machine, paste the owner access key, create
an account and select **Pair with QR**. On the phone choose **WhatsApp → Linked
devices → Link a device**. Repeat for each number. If the server is remote, use
an SSH port forward or configure HTTPS as described in
[deployment](docs/deployment.md).

The access key above is private. The generated keys and SQLite files stay in a
persistent Docker volume. Do not remove the volume when upgrading.

For public MCP access, set `WA_PUBLIC_URL=https://whatsapp.example.com` and put
an HTTPS reverse proxy or tunnel in front of port 8787. The MCP endpoint is
`https://whatsapp.example.com/mcp`. The Compose port remains bound to loopback.

## Run from source

Requires **Node.js 24 or newer** and npm.

```sh
git clone https://github.com/kaizentrick/whatsapp-mcp.git
cd whatsapp-mcp
npm ci
npm run build
export WA_DATA_DIR="$PWD/data"
node dist/cli.js init
node dist/cli.js serve
```

Open the same web page. Read the private `data/admin.token` locally to sign in.
The default data location without `WA_DATA_DIR` is
`$XDG_DATA_HOME/whatsapp-mcp` or `~/.local/share/whatsapp-mcp`.

## Connect an agent

Any agent supporting MCP **Streamable HTTP with OAuth or Bearer authentication**
can use `/mcp`. Agents supporting **stdio** can run the included bridge:

```sh
WA_SERVER_URL=https://whatsapp.example.com \
WA_CLIENT_TOKEN_FILE=/private/path/client.token \
node /absolute/path/whatsapp-mcp/dist/cli.js stdio
```

The bridge connects to the running service; it does not open another WhatsApp
session. See [client examples](docs/clients.md) for Codex and a generic
`mcpServers` configuration. Compatibility depends on each client's supported
MCP transports and authentication methods.

Generate a separate credential for each agent, restricted to one account:

```sh
node dist/cli.js token:create --account Sales \
  --permissions read,send --days 30 --out /private/path/sales-agent.token
```

Keep the same `WA_DATA_DIR` setting used by the service. Without `send`, an agent
cannot send; without `manage`, it cannot pair, pause or unlink accounts. The
owner credential can access all accounts. OAuth consent can reduce granted
permissions further. Credentials are revocable.

## Features and boundaries

- Multiple isolated accounts, each bound to the first paired phone identity.
- QR rotation and expiry, reconnect backoff, durable Signal credentials and keys.
- Twenty focused tools, pagination, group participant identifiers and PN/LID aliases.
- Text, images, documents and audio; bounded base64 uploads and media downloads.
- Idempotent send requests and explicit handling of uncertain send outcomes.
- OAuth discovery, dynamic registration, PKCE S256 and rotating refresh tokens.
- Private local SQLite storage; credentials, raw messages and OAuth records are
  encrypted. Searchable text and routing metadata are **not** encrypted at rest.
- No campaigns, AI models, workflows, billing, CRM or automated replies.

An unsaved contact can receive messages if the number is registered on WhatsApp.
A number without a WhatsApp account cannot. History is limited to what WhatsApp
synchronizes to the linked device. The service does not promise a complete copy
of everything on the phone. Messages are read from stored history without marking
them as read. Group receipts retain participant identity.

This uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys)
WhatsApp Web transport. Protocol changes, account restrictions and pairing
requirements remain external constraints. This is not the official Meta
Business Platform and is not affiliated with WhatsApp or Meta.

## Development

```sh
npm ci
npm test
npm run check
npm run audit:runtime
docker build -t whatsapp-mcp:local .
```

CI runs the tests and starts/restarts the non-root container. Tests never send
real messages. For an explicit, disposable real-network QR check:

```sh
npm run build
node scripts/smoke-qr.mjs
```

This creates a temporary unpaired session, reports only whether a QR arrived,
and removes its temporary state. It never prints the QR payload or sends a
message. See [acceptance](docs/acceptance.md) for real-phone verification.

## License

Project source is **GPL-3.0-only**, with third-party components under their
respective licenses. See [LICENSE](LICENSE) and [NOTICE](NOTICE). This repository
does not copy Evolution API implementation code. Baileys is MIT licensed;
the runtime dependency `libsignal` is GPL-3.0.
