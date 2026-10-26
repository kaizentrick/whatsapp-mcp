# MCP tools

Every account operation requires `account`, an account ID or exact name. An
account credential can access only its own account, including when a caller
manually supplies another account's name. Default pagination is 25, maximum 100.
Unknown fields are rejected. Permissions are checked on tool listing and calls.

| Tool | Permission | Purpose |
| --- | --- | --- |
| `whatsapp_account_list` | read | Accessible account IDs, phone identity, state and synchronization |
| `whatsapp_account_create` | manage, owner only | Create an unpaired account |
| `whatsapp_account_status` | read | Connection state and last error |
| `whatsapp_pairing_start` | manage | Start/resume one session |
| `whatsapp_pairing_get` | manage | Current QR image, generation and expiry, or connection state |
| `whatsapp_account_disconnect` | manage | Pause; preserve credentials |
| `whatsapp_account_logout` | manage | Unlink and erase session keys; requires `confirm: true` |
| `whatsapp_profile_get` | read | Stable identity of this authenticated connection |
| `whatsapp_chat_list` | read | Stored direct and group chats |
| `whatsapp_contact_search` | read | Stored names and phone identifiers |
| `whatsapp_number_check` | read | Check up to 20 phone numbers on WhatsApp |
| `whatsapp_message_list` | read | Stored text/captions, identity, timestamps and status |
| `whatsapp_message_get` | read | One message by ID, optional chat and `fromMe` |
| `whatsapp_message_status` | read | Persistent request outcome and message/participant receipts |
| `whatsapp_group_list` | read | Groups the account belongs to |
| `whatsapp_group_get` | read | Subject, description and paginated participants |
| `whatsapp_message_send` | send | One text, explicit recipient and `requestId` |
| `whatsapp_media_get` | read | Attachment as bounded MCP embedded binary resource |
| `whatsapp_media_send` | send | Base64 image/document/audio, optional caption |
| `whatsapp_health_get` | read | Service version and accessible account states |

Inspect `tools/list` for the authoritative JSON schemas. A read-only credential
exposes 13 tools. A credential with `read,send` exposes 15. Management tools are
available only with `manage`; account creation is additionally owner-only.

Message output preserves original `id`, `chatId`, `remoteJidAlt`, `fromMe`,
`participant` and `participantAlt`. PN/LID mappings are scoped to an account.
An opaque LID is never interpreted as a phone number. Canonical chat indexing
merges observed aliases while the raw provider identity remains intact.

`accepted` means the transport returned a message ID. `SERVER_ACK`,
`DELIVERY_ACK` and `READ` are separate provider events, retained monotonically.
A group participant's read receipt is recorded for that participant; it is not
reported as proof that everyone read the message. If no receipt arrived, the
service does not infer delivery.

Send operation states are `queued`, `sending`, `sent`, `rejected` (validation or
connection check failed before sending) and `unknown` (the send may have reached
WhatsApp). A crash with `queued`/`sending` is treated conservatively on replay.
Never create a new request ID automatically after an uncertain outcome.

Media is limited to `WA_MAX_MEDIA_BYTES`. Uploads accept bytes, not server paths
or arbitrary URLs. There is no transcoding, link scraping or video tool in v0.1.
Downloaded attachments use an opaque `wa-media://` resource identifier.

QR images and media are standard MCP content blocks. An agent without image or
binary rendering can still use text tools; use the web page for QR pairing.
