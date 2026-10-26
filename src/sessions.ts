import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  generateMessageIDV2,
  getContentType,
  normalizeMessageContent,
  jidNormalizedUser,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
import { Store, hash, type Account, type StoredMessage } from "./store.js";
import {
  baileysDriver,
  DisconnectReason,
  initAuthCreds,
  proto,
  type DriverFactory,
  type SocketPort,
  type EventBatch,
} from "./driver.js";

type Runtime = {
  socket?: SocketPort;
  creds: any;
  closed: boolean;
  generation: number;
  qr?: {
    value: string;
    generation: number;
    createdAt: number;
    expiresAt: number;
  };
  queue: Promise<void>;
  retry?: NodeJS.Timeout;
  attempts: number;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Provider operation failed";
export class Sessions {
  private active = new Map<string, Runtime>();
  private starting = new Map<string, Promise<Account>>();
  private sending = new Map<string, Promise<unknown>>();
  private sendQueues = new Map<string, Promise<unknown>>();
  private stopped = false;
  constructor(
    readonly store: Store,
    private driver: DriverFactory = baileysDriver,
    private maxMediaBytes = 5 * 1024 * 1024,
  ) {}
  async resume(): Promise<void> {
    for (const a of this.store.accounts())
      if (a.autoStart) await this.start(a.id).catch(() => {});
  }
  start(nameOrId: string): Promise<Account> {
    const account = this.store.account(nameOrId),
      pending = this.starting.get(account.id);
    if (pending) return pending;
    const work = this.connect(account).finally(() =>
      this.starting.delete(account.id),
    );
    this.starting.set(account.id, work);
    return work;
  }
  private async connect(account: Account): Promise<Account> {
    if (this.stopped) throw new Error("Service is shutting down");
    this.store.assertLease();
    const old = this.active.get(account.id);
    if (old && !old.closed) return this.store.account(account.id);
    if (old) {
      if (old.retry) clearTimeout(old.retry);
      await old.socket?.close();
    }
    const rt: Runtime = {
      creds: this.store.get("auth", account.id, "creds") ?? initAuthCreds(),
      closed: false,
      generation: (old?.generation ?? 0) + 1,
      queue: Promise.resolve(),
      attempts: old?.attempts ?? 0,
    };
    this.active.set(account.id, rt);
    this.store.updateAccount(account.id, {
      state: "connecting",
      autoStart: true,
      lastError: null,
    });
    const guard = () => {
      this.store.assertLease();
      if (this.active.get(account.id) !== rt || rt.closed)
        throw new Error("Stale WhatsApp session");
    };
    const auth: AuthenticationState = {
      creds: rt.creds,
      keys: {
        get: async (type, ids) => {
          guard();
          const out: any = {};
          for (const id of ids) {
            let value = this.store.get("auth", account.id, `${type}:${id}`);
            if (type === "app-state-sync-key" && value)
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value !== undefined) out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          guard();
          this.store.transaction(() => {
            for (const [kind, entries] of Object.entries(data))
              for (const [id, value] of Object.entries(entries ?? {})) {
                if (value == null)
                  this.store.remove("auth", account.id, `${kind}:${id}`);
                else this.store.put("auth", account.id, `${kind}:${id}`, value);
              }
          });
        },
      },
    };
    try {
      rt.socket = await this.driver({
        auth,
        getMessage: async (key) =>
          (
            this.store.messages(account.id, {
              id: key.id,
              chat: key.remoteJid,
              fromMe: key.fromMe,
              limit: 1,
              offset: 0,
            })[0]?.raw as any
          )?.message,
        onEvents: (events) => {
          rt.queue = rt.queue
            .catch(() => {})
            .then(() => this.events(account.id, rt, events));
          return rt.queue.catch((error) =>
            this.providerError(account.id, rt, error),
          );
        },
        onError: (error) => this.providerError(account.id, rt, error),
      });
      if (this.active.get(account.id) !== rt || this.stopped) {
        await rt.socket.close();
        throw new Error("Pairing was cancelled");
      }
      return this.store.account(account.id);
    } catch (error) {
      this.providerError(account.id, rt, error);
      if (this.active.get(account.id) === rt) {
        rt.closed = true;
        this.retry(account.id, rt);
      }
      throw error;
    }
  }
  private retry(id: string, rt: Runtime, immediate = false): void {
    const wait = immediate
      ? 250
      : Math.min(60000, 1000 * 2 ** Math.min(rt.attempts++, 6)) +
        Math.floor(Math.random() * 500);
    rt.retry = setTimeout(() => {
      if (this.active.get(id) === rt && !this.stopped)
        void this.start(id).catch(() => {});
    }, wait);
    rt.retry.unref();
  }
  private providerError(id: string, rt: Runtime, error: unknown): void {
    if (this.active.get(id) !== rt) return;
    try {
      this.store.assertLease();
    } catch {
      return;
    }
    this.store.updateAccount(id, {
      state: "error",
      lastError: errorText(error).slice(0, 300),
    });
  }
  private async events(
    id: string,
    rt: Runtime,
    events: EventBatch,
  ): Promise<void> {
    if (this.active.get(id) !== rt || this.stopped) return;
    this.store.assertLease();
    if (events["creds.update"]) {
      Object.assign(rt.creds, events["creds.update"]);
      this.store.put("auth", id, "creds", rt.creds);
    }
    const connection = events["connection.update"];
    if (connection?.qr) {
      const at = Date.now();
      rt.qr = {
        value: connection.qr,
        generation: ++rt.generation,
        createdAt: at,
        expiresAt: at + 43000,
      };
      this.store.updateAccount(id, { state: "qr" });
    }
    if (connection?.connection === "open") {
      rt.qr = undefined;
      rt.attempts = 0;
      const user = rt.socket?.user();
      const account = this.store.account(id);
      const selfJid = user?.id ? jidNormalizedUser(user.id) : null;
      const changed = account.selfJid && selfJid && account.selfJid !== selfJid;
      if (changed) {
        rt.closed = true;
        this.active.delete(id);
        this.store.clear("auth", id);
        this.store.updateAccount(id, {
          state: "identity_mismatch",
          autoStart: false,
          epoch: account.epoch + 1,
          lastError:
            "This account belongs to a different number. Create a new account for the new number.",
        });
        void rt.socket
          ?.logout()
          .catch(() => {})
          .finally(() => rt.socket?.close().catch(() => {}));
        return;
      }
      this.store.updateAccount(id, {
        state: "open",
        selfJid,
        label: user?.name ?? account.label,
        lastError: null,
        syncStatus:
          account.syncStatus === "unknown" ? "syncing" : account.syncStatus,
      });
      this.store.put("auth", id, "creds", rt.creds);
    }
    const history = events["messaging-history.set"];
    if (history) {
      this.store.updateAccount(id, {
        syncStatus: history.isLatest ? "latest_batch_received" : "syncing",
        syncProgress:
          typeof history.progress === "number" ? history.progress : null,
      });
    }
    for (const contact of [
      ...(history?.contacts ?? []),
      ...(events["contacts.upsert"] ?? []),
      ...(events["contacts.update"] ?? []),
    ]) {
      if (!contact.id) continue;
      this.store.saveContact(
        id,
        contact.id,
        contact.name ?? contact.notify ?? contact.verifiedName ?? null,
        contact.phoneNumber ?? null,
        contact.lid ?? (contact.id.endsWith("@lid") ? contact.id : null),
      );
    }
    for (const mapping of events["lid-mapping.update"]
      ? [events["lid-mapping.update"]].flat()
      : [])
      if (mapping.pn && mapping.lid)
        this.store.alias(id, mapping.pn, mapping.lid);
    for (const chat of [
      ...(history?.chats ?? []),
      ...(events["chats.upsert"] ?? []),
      ...(events["chats.update"] ?? []),
    ])
      if (chat.id)
        this.store.saveChat(
          id,
          chat.id,
          chat.name ?? null,
          Number(chat.conversationTimestamp ?? 0),
          chat.unreadCount ?? 0,
        );
    const messages = [
      ...(history?.messages ?? []),
      ...(events["messages.upsert"]?.messages ?? []),
    ];
    for (let i = 0; i < messages.length; i++) {
      if (this.active.get(id) !== rt || rt.closed || this.stopped) return;
      this.ingest(id, messages[i]);
      if (i % 100 === 99) {
        await yieldTurn();
        this.store.assertLease();
      }
    }
    for (const update of events["messages.update"] ?? []) {
      if (update.update?.status !== undefined)
        this.store.receipt(
          id,
          update.key,
          ["ERROR", "PENDING", "SERVER_ACK", "DELIVERY_ACK", "READ", "PLAYED"][
            Number(update.update.status)
          ] ?? String(update.update.status),
        );
    }
    for (const receipt of events["message-receipt.update"] ?? [])
      if (receipt.receipt?.readTimestamp)
        this.store.receipt(
          id,
          receipt.key,
          "READ",
          receipt.receipt.userJid ?? "",
        );
      else if (receipt.receipt?.receiptTimestamp)
        this.store.receipt(
          id,
          receipt.key,
          "DELIVERY_ACK",
          receipt.receipt.userJid ?? "",
        );
    for (const group of [
      ...(events["groups.upsert"] ?? []),
      ...(events["groups.update"] ?? []),
    ])
      if (group.id) {
        this.store.remove("group", id, group.id);
        this.store.saveChat(id, group.id, group.subject ?? null);
      }
    if (events["group-participants.update"]?.id)
      this.store.remove("group", id, events["group-participants.update"].id);
    if (connection?.connection === "close") {
      rt.closed = true;
      rt.qr = undefined;
      const code = connection.lastDisconnect?.error?.output?.statusCode;
      if (
        code === DisconnectReason.loggedOut ||
        code === DisconnectReason.forbidden
      ) {
        this.store.clear("auth", id);
        this.store.updateAccount(id, {
          state: "logged_out",
          autoStart: false,
          lastError: "WhatsApp requires a new QR pairing",
          epoch: this.store.account(id).epoch + 1,
        });
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        this.store.updateAccount(id, {
          state: "replaced",
          autoStart: false,
          lastError:
            "Another device replaced this connection; resume manually.",
        });
        return;
      }
      this.store.updateAccount(id, { state: "reconnecting", lastError: null });
      this.retry(id, rt, code === DisconnectReason.restartRequired);
    }
  }
  ingest(account: string, raw: any): void {
    const key = raw?.key;
    if (!key?.id || !key.remoteJid || !raw.message) return;
    const message = normalizeMessageContent(raw.message) ?? raw.message,
      type = getContentType(message) ?? "unknown";
    const value = (message as any)[type];
    const text =
      typeof value === "string" ? value : (value?.text ?? value?.caption ?? "");
    if (key.remoteJidAlt) {
      const lid = key.remoteJid.endsWith("@lid")
        ? key.remoteJid
        : key.remoteJidAlt.endsWith("@lid")
          ? key.remoteJidAlt
          : null;
      const pn = key.remoteJid.endsWith("@s.whatsapp.net")
        ? key.remoteJid
        : key.remoteJidAlt.endsWith("@s.whatsapp.net")
          ? key.remoteJidAlt
          : null;
      if (lid && pn) this.store.alias(account, pn, lid);
    }
    const stored: StoredMessage = {
      id: key.id,
      chatId: key.remoteJid,
      fromMe: !!key.fromMe,
      participant: key.participant,
      participantAlt: key.participantAlt,
      remoteJidAlt: key.remoteJidAlt,
      timestamp: Number(raw.messageTimestamp ?? 0),
      type,
      text,
      status: key.fromMe ? "PENDING" : "RECEIVED",
      raw,
    };
    this.store.saveMessage(account, stored);
  }
  qr(nameOrId: string) {
    const a = this.store.account(nameOrId),
      qr = this.active.get(a.id)?.qr;
    return qr && qr.expiresAt > Date.now() ? { account: a.id, ...qr } : null;
  }
  private socket(id: string): SocketPort {
    const a = this.store.account(id),
      rt = this.active.get(a.id);
    if (a.state !== "open" || !rt?.socket || rt.closed)
      throw new Error("Account is not connected");
    this.store.assertLease();
    return rt.socket;
  }
  async disconnect(id: string): Promise<Account> {
    const a = this.store.account(id),
      rt = this.active.get(a.id);
    this.active.delete(a.id);
    if (rt?.retry) clearTimeout(rt.retry);
    this.store.updateAccount(a.id, { autoStart: false, state: "paused" });
    await rt?.socket?.close();
    return this.store.account(a.id);
  }
  async logout(id: string): Promise<Account> {
    const a = this.store.account(id),
      socket = this.socket(a.id);
    await socket.logout();
    await this.disconnect(a.id);
    this.store.clear("auth", a.id);
    this.store.updateAccount(a.id, { state: "logged_out", epoch: a.epoch + 1 });
    return this.store.account(a.id);
  }
  async check(id: string, numbers: string[]) {
    if (numbers.some((n) => !/^\d{7,16}$/.test(n)))
      throw new Error("Use digits with country code");
    return this.socket(id).check(numbers);
  }
  private async destination(id: string, target: string): Promise<string> {
    if (/^[\w:.-]+@(g\.us|lid|s\.whatsapp\.net)$/.test(target)) {
      if (target.endsWith("@g.us") || target.endsWith("@lid")) return target;
      target = target.split("@")[0]!;
    }
    if (!/^\+?\d{7,16}$/.test(target))
      throw new Error("Use a WhatsApp phone number or JID");
    target = target.replace(/^\+/, "");
    const self = this.store.account(id).selfJid;
    if (self?.split("@")[0] === target) return self;
    const rows = await this.check(id, [target]);
    const found = rows[0];
    if (!found?.exists || !found.jid)
      throw new Error("Recipient is not registered on WhatsApp");
    return found.jid;
  }
  async send(
    id: string,
    target: string,
    requestId: string,
    content: {
      text?: string;
      media?: {
        kind: "image" | "document" | "audio";
        base64: string;
        mimeType: string;
        fileName?: string;
      };
    },
  ): Promise<any> {
    const a = this.store.account(id);
    const fingerprint = hash(JSON.stringify({ target, content }));
    const opKey = a.id + ":" + requestId;
    const previous = this.store.get<any>("outbox", a.id, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("requestId was already used for a different message");
      if (previous.state === "sent") return previous.result;
      if (previous.state === "rejected")
        throw new Error(
          "Previous request was rejected before sending. Correct the input and use a new requestId.",
        );
      if (this.sending.has(opKey)) return this.sending.get(opKey);
      throw new Error(
        "Previous send outcome is unknown. Check message_status before retrying; use no new requestId automatically.",
      );
    }
    const providerId = generateMessageIDV2(a.selfJid ?? undefined);
    this.store.assertLease();
    this.store.put("outbox", a.id, requestId, {
      fingerprint,
      state: "queued",
      providerId,
      target,
      createdAt: Date.now(),
    });
    const run = (this.sendQueues.get(a.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.store.assertLease();
        const socket = this.socket(a.id);
        const jid = await this.destination(a.id, target);
        let payload: any = { text: content.text ?? "", linkPreview: undefined };
        if (content.media) {
          const m = content.media;
          if (
            m.base64.length > Math.ceil(this.maxMediaBytes / 3) * 4 + 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(m.base64) ||
            m.base64.length % 4 !== 0
          )
            throw new Error(
              "Media base64 is invalid or exceeds the upload limit",
            );
          const bytes = Buffer.from(m.base64, "base64");
          if (bytes.length > this.maxMediaBytes)
            throw new Error("Media exceeds limit");
          payload = {
            [m.kind]: bytes,
            mimetype: m.mimeType,
            fileName: m.fileName ?? "attachment",
            caption: content.text,
            jpegThumbnail: Buffer.alloc(0),
          };
        }
        this.store.put("outbox", a.id, requestId, {
          fingerprint,
          state: "sending",
          providerId,
          target: jid,
          createdAt: Date.now(),
        });
        try {
          this.store.assertLease();
          const sent = await socket.send(jid, payload, providerId);
          if (!sent?.key?.id)
            throw new Error("Provider did not return a message ID");
          this.ingest(a.id, sent);
          const result = {
            requestId,
            messageId: sent.key.id,
            chatId: sent.key.remoteJid,
            status: "accepted",
            note: "Accepted by WhatsApp transport; delivery is reported separately.",
          };
          this.store.put("outbox", a.id, requestId, {
            fingerprint,
            state: "sent",
            providerId: sent.key.id,
            target: jid,
            result,
          });
          return result;
        } catch (error) {
          this.store.put("outbox", a.id, requestId, {
            fingerprint,
            state: "unknown",
            providerId,
            target: jid,
            error: errorText(error),
          });
          throw new Error(
            "Send outcome is unknown. Query message_status; do not blindly retry.",
          );
        }
      });
    this.sendQueues.set(a.id, run);
    this.sending.set(opKey, run);
    try {
      return await run;
    } catch (error) {
      const op = this.store.get<any>("outbox", a.id, requestId);
      if (op?.state === "queued")
        this.store.put("outbox", a.id, requestId, {
          ...op,
          state: "rejected",
          error: errorText(error),
        });
      throw error;
    } finally {
      this.sending.delete(opKey);
      if (this.sendQueues.get(a.id) === run) this.sendQueues.delete(a.id);
    }
  }
  async groups(id: string) {
    const groups = await this.socket(id).groups();
    return Object.values(groups).map((g: any) => ({
      id: g.id,
      name: g.subject,
      size: g.size ?? g.participants?.length,
    }));
  }
  async group(id: string, jid: string) {
    if (!jid.endsWith("@g.us")) throw new Error("Expected a group JID");
    const a = this.store.account(id);
    let value = this.store.get<any>("group", a.id, jid);
    if (!value) {
      value = await this.socket(a.id).group(jid);
      this.store.put("group", a.id, jid, value, Date.now() + 60000);
    }
    return value;
  }
  async media(id: string, messageId: string, chatId?: string): Promise<Buffer> {
    const a = this.store.account(id),
      m = this.store.messages(a.id, {
        id: messageId,
        chat: chatId,
        limit: 2,
        offset: 0,
      });
    if (m.length !== 1) throw new Error("Provide a unique message ID and chat");
    const stream = await this.socket(a.id).media(m[0]!.raw);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > this.maxMediaBytes) {
        (stream as any).destroy?.();
        throw new Error("Media exceeds configured limit");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const [id, rt] of this.active) {
      if (rt.retry) clearTimeout(rt.retry);
      this.active.delete(id);
      await rt.socket?.close().catch(() => {});
      await rt.queue.catch(() => {});
    }
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled(this.sending.values());
  }
}
