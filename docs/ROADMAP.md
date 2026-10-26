# Roadmap: replace Evolution with a focused WhatsApp MCP service

## 1. Independent core - implemented in v0.1

Use Baileys directly behind a small adapter. Keep QR pairing, persistent
multi-account sessions, stored chats/messages/contacts, groups and sending.
Exclude Evolution's CRM, campaign, AI-provider, queue and workflow integrations.
The repository contains no copied Evolution implementation code.

Deliver one Node 24 service, local SQLite, encrypted auth/key persistence,
account identity boundaries, a writer lease, bounded media and idempotent sends.

## 2. Standard agent interface - implemented in v0.1

Streamable HTTP MCP, stdio bridge, OAuth/PKCE and native account credentials.
Twenty focused tools with explicit account selection. Permissions independently
control read, send and management. No model vendor dependency.

## 3. Installable distribution - implemented in v0.1

Public source, lockfile, non-root Docker build, Compose, systemd/Caddy examples,
English/Spanish documentation, CI, license and a real-network QR smoke command.
Builders can deploy under their own domain and use their own phone numbers.

## 4. Real-phone acceptance - required for each deployment

Follow [acceptance.md](acceptance.md). Pair fresh devices for two owned numbers,
observe both receiving directions and provider receipts, self messages and an
unsaved consenting contact. Validate group reads, restart continuity, permission
isolation and the actual target agent clients. Record observed results separately
from automated tests. No fixed date substitutes for these checks.

## 5. Controlled migration from Evolution - after acceptance

- Inventory the old release, services, tunnel routes, account IDs, history and
  **all** auth storage locations. Depending on its configuration, Evolution can
  split credentials, Signal keys and history across PostgreSQL, Redis and files.
- Back up and verify the complete old deployment before changing it. Keep its
  current paired sessions working while the new backend is linked independently.
- Prefer a fresh QR-linked device for the new backend. Do not give two services
  ownership of the same Signal state or restore an old ratchet snapshot as an
  ordinary rollback method.
- Historical imports, if needed, must preserve the original account, remote JID,
  message ID, `fromMe`, participant and alternate identity. Mark imports as
  historical and never turn them into send operations. A production Evolution
  export/import adapter is not included in v0.1; agree the required history and
  schema before implementing it.
- Move a test agent first, then the remaining agents. Keep authentication and
  endpoint changes explicit. Observe reconnects, delivery and storage growth.
- Only after acceptance, stop the old services and remove their dedicated tunnel
  routes/dependencies. Verify the new endpoint and other server workloads.
  Retain a private recovery backup according to the operator's retention policy.

## Later, driven by actual use

Add storage retention/export controls, operational metrics, broader client
interoperability evidence and explicit release upgrade migrations. Consider
additional message types only when the agent workflow needs them. Avoid rebuilding
a general automation platform around this small transport service.
