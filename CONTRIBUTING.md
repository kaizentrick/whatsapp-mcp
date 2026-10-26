# Contributing

Use Node 24+ and `npm ci`. Run `npm test`, `npm run check` and
`npm run audit:runtime` before submitting changes. Keep tests deterministic and
network-free; real-network tests must remain explicit opt-in commands.

Keep the scope focused on WhatsApp account sessions and standard MCP tools.
Use a transport adapter for provider behavior. Preserve account boundaries,
complete message identity and uncertain-send handling. Do not add integrations
requiring a particular model provider.

Never commit live credentials, phone data, QR values or provider test messages.
Use fictional data and describe separately what an automated test proves and
what was actually observed with a real phone. Follow SECURITY.md for sensitive
reports. Contributions are distributed under this repository's GPL-3.0-only
license and must preserve third-party notices.
