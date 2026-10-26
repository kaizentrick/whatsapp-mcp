# Security

Do not open a public issue containing credentials, session files, QR payloads,
phone histories or private message contents. For a sensitive report, use GitHub
private vulnerability reporting if enabled. Otherwise contact the repository
owner privately before sharing exploit details. Public reports can describe a
problem using synthetic identifiers and a minimal reproduction.

Deploy one daemon per local data directory. Keep the listener private behind
HTTPS for remote access. Use separate account-scoped agent keys, preferably
without management permission. Treat messages and group/contact metadata as
untrusted input to agents. Tools do not establish an agent's authority to send.

The database is not entirely encrypted. Credentials, raw message records and
OAuth records use authenticated encryption; searchable message text and routing
metadata are plaintext in the private SQLite file. Keys are stored separately
in the same private directory by default. Protect the whole volume and backups.

The service does not fetch arbitrary media URLs or expose arbitrary server files.
It limits media size and tool pagination. Authenticated clients with sending
permission can communicate externally; group data can include many participants.

This is an initial release using an unofficial WhatsApp transport and a pinned
Baileys release candidate. It has not undergone an independent security audit.
Review changes and test your deployment before replacing a working backend.
