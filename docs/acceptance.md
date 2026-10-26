# Deployment acceptance

Automated tests prove behavior against a controlled transport and real MCP SDK
clients. They cover encryption, account isolation, writer fencing, QR generations,
reconnect behavior, durable Signal keys, message identity, receipts, send
idempotency, media limits, OAuth and HTTP/stdio interoperability. They do not
prove real phone pairing or delivery.

`node scripts/smoke-qr.mjs` is an optional real-network check for receipt of a
fresh QR. It does not pair a phone, read a real inbox or send a real message.

Before switching an existing installation:

1. Build and start the service using an independent data directory and port.
2. Pair two operator-owned test numbers as separate accounts. Use fresh linked
   devices; do not copy another backend's active Signal credentials.
3. Confirm each account identity, available chats, contact search, group subjects
   and participants through MCP. Document the history actually synchronized.
4. Use account-scoped credentials to verify account A cannot read or send as B,
   and a read-only credential cannot invoke sending or pairing tools.
5. With the operator's sending authorization, send one identifiable A→B message
   and one B→A reply. Match the provider message ID in sender and receiver stores,
   with receiver `fromMe: false`, including observed PN/LID aliases.
6. Check self-message behavior. With a consenting recipient, verify a number that
   is absent from contacts. Test a consenting group if group sending is required.
7. Repeat an identical `requestId` and verify no second provider send occurs.
   Inspect status after simulated disconnection; never blindly resend.
8. Restart the service while preserving data. Confirm sessions resume without
   an unexpected QR, and incoming messages continue. Check receipt identity.
9. Connect one actual target agent via HTTP/OAuth and another via stdio or Bearer.
   Verify read/send permissions and revocation with those clients.
10. Save a redacted verification receipt containing versions, timestamps, account
    labels, message IDs and observed outcomes. Do not include keys, QR payloads
    or private message bodies in a public repository.

After acceptance, switch agents to the new endpoint and observe it before retiring
the old backend. A successful QR smoke check alone is insufficient for retirement.
