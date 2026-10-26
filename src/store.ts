import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const encode = (value: unknown) =>
  JSON.stringify(value, (_k, v) =>
    v instanceof Uint8Array
      ? { __bytes: Buffer.from(v).toString("base64") }
      : v,
  );
const decode = (value: string) =>
  JSON.parse(value, (_k, v) =>
    v && v.__bytes
      ? Buffer.from(v.__bytes, "base64")
      : v?.type === "Buffer" && Array.isArray(v.data)
        ? Buffer.from(v.data)
        : v,
  );
export type Account = {
  id: string;
  name: string;
  selfJid: string | null;
  label: string | null;
  state: string;
  autoStart: boolean;
  epoch: number;
  profileId: string;
  syncStatus: string;
  syncProgress: number | null;
  lastError: string | null;
};
export type StoredMessage = {
  id: string;
  chatId: string;
  fromMe: boolean;
  participant?: string;
  participantAlt?: string;
  remoteJidAlt?: string;
  timestamp: number;
  type: string;
  text: string;
  status: string;
  raw: unknown;
};
type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  private lease?: { owner: string; fence: number };
  constructor(
    file: string,
    private readonly key: Buffer,
  ) {
    this.db = new DatabaseSync(file);
    if (file !== ":memory:" && process.platform !== "win32")
      chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,self_jid TEXT,label TEXT,state TEXT NOT NULL DEFAULT 'disconnected',autostart INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,profile_id TEXT NOT NULL,sync_status TEXT NOT NULL DEFAULT 'unknown',sync_progress REAL,last_error TEXT);
      CREATE TABLE IF NOT EXISTS slots(kind TEXT NOT NULL,account TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,expires INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,PRIMARY KEY(kind,account,id));
      CREATE TABLE IF NOT EXISTS aliases(account TEXT,alias TEXT,canonical TEXT,PRIMARY KEY(account,alias));
      CREATE TABLE IF NOT EXISTS chats(account TEXT,jid TEXT,name TEXT,kind TEXT,ts INTEGER DEFAULT 0,unread INTEGER DEFAULT 0,PRIMARY KEY(account,jid));
      CREATE TABLE IF NOT EXISTS contacts(account TEXT,jid TEXT,name TEXT,phone TEXT,lid TEXT,PRIMARY KEY(account,jid));
      CREATE TABLE IF NOT EXISTS messages(account TEXT,id TEXT,chat TEXT,from_me INTEGER,ts INTEGER,type TEXT,text TEXT,status TEXT,raw BLOB,PRIMARY KEY(account,id,chat,from_me));
      CREATE INDEX IF NOT EXISTS message_page ON messages(account,ts DESC,id DESC);
      CREATE INDEX IF NOT EXISTS message_chat ON messages(account,chat,ts DESC,id DESC);
      CREATE TABLE IF NOT EXISTS receipts(account TEXT,id TEXT,chat TEXT,participant TEXT NOT NULL DEFAULT '',status TEXT,updated INTEGER,PRIMARY KEY(account,id,chat,participant));
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,expires INTEGER,fence INTEGER);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private seal(value: unknown, aad: string): Buffer {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(encode(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  private open(value: Uint8Array, aad: string): any {
    const b = Buffer.from(value),
      dec = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    dec.setAAD(Buffer.from(aad));
    dec.setAuthTag(b.subarray(12, 28));
    return decode(
      Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString(),
    );
  }
  put(
    kind: string,
    account: string,
    id: string,
    value: unknown,
    expires = 0,
  ): void {
    this.db
      .prepare("INSERT OR REPLACE INTO slots VALUES(?,?,?,?,?,?)")
      .run(
        kind,
        account,
        id,
        this.seal(value, `${kind}:${account}:${id}`),
        expires,
        Date.now(),
      );
  }
  get<T = any>(kind: string, account: string, id: string): T | undefined {
    const r = this.db
      .prepare(
        "SELECT data,expires FROM slots WHERE kind=? AND account=? AND id=?",
      )
      .get(kind, account, id) as Row | undefined;
    if (!r || (Number(r.expires) > 0 && Number(r.expires) <= Date.now()))
      return undefined;
    return this.open(r.data as Uint8Array, `${kind}:${account}:${id}`) as T;
  }
  remove(kind: string, account: string, id: string): void {
    this.db
      .prepare("DELETE FROM slots WHERE kind=? AND account=? AND id=?")
      .run(kind, account, id);
  }
  clear(kind: string, account: string): void {
    this.db
      .prepare("DELETE FROM slots WHERE kind=? AND account=?")
      .run(kind, account);
  }
  createAccount(name: string): Account {
    if (!/^[\p{L}\p{N} _.-]{1,64}$/u.test(name) || name !== name.trim())
      throw new Error(
        "Use a trimmed account name with 1-64 letters, numbers, spaces, dots or hyphens",
      );
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO accounts(id,name,profile_id) VALUES(?,?,?)")
      .run(id, name, randomUUID());
    return this.account(id);
  }
  account(nameOrId: string): Account {
    const r = this.db
      .prepare("SELECT * FROM accounts WHERE id=? OR name=?")
      .get(nameOrId, nameOrId) as Row | undefined;
    if (!r) throw new Error("Account not found");
    return {
      id: String(r.id),
      name: String(r.name),
      selfJid: r.self_jid as string | null,
      label: r.label as string | null,
      state: String(r.state),
      autoStart: !!r.autostart,
      epoch: Number(r.epoch),
      profileId: String(r.profile_id),
      syncStatus: String(r.sync_status),
      syncProgress: r.sync_progress as number | null,
      lastError: r.last_error as string | null,
    };
  }
  accounts(): Account[] {
    return (
      this.db.prepare("SELECT id FROM accounts ORDER BY name").all() as Row[]
    ).map((r) => this.account(String(r.id)));
  }
  updateAccount(id: string, patch: Partial<Account>): void {
    const fields: Record<string, string> = {
      selfJid: "self_jid",
      label: "label",
      state: "state",
      autoStart: "autostart",
      epoch: "epoch",
      profileId: "profile_id",
      syncStatus: "sync_status",
      syncProgress: "sync_progress",
      lastError: "last_error",
    };
    const entries = Object.entries(patch).filter(([k]) => fields[k]);
    if (!entries.length) return;
    this.db
      .prepare(
        `UPDATE accounts SET ${entries.map(([k]) => fields[k] + "=?").join(",")} WHERE id=?`,
      )
      .run(
        ...(entries.map(([, v]) =>
          typeof v === "boolean" ? Number(v) : (v ?? null),
        ) as any[]),
        id,
      );
  }
  canonical(account: string, jid: string): string {
    return String(
      (
        this.db
          .prepare("SELECT canonical FROM aliases WHERE account=? AND alias=?")
          .get(account, jid) as Row | undefined
      )?.canonical ?? jid,
    );
  }
  alias(account: string, alias: string, canonical: string): void {
    if (/^\d+$/.test(alias)) alias += "@s.whatsapp.net";
    if (!alias.endsWith("@s.whatsapp.net") || !canonical.endsWith("@lid"))
      return;
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO aliases VALUES(?,?,?)")
        .run(account, alias, canonical);
      const rows = this.db
        .prepare("SELECT * FROM messages WHERE account=? AND chat=?")
        .all(account, alias) as Row[];
      for (const r of rows) {
        const m = this.open(
          r.raw as Uint8Array,
          `message:${account}:${r.id}:${r.chat}:${r.from_me}`,
        );
        this.saveMessage(account, { ...m, status: r.status });
      }
      this.db
        .prepare("DELETE FROM messages WHERE account=? AND chat=?")
        .run(account, alias);
      const chat = this.db
        .prepare("SELECT * FROM chats WHERE account=? AND jid=?")
        .get(account, alias) as Row | undefined;
      if (chat) {
        this.saveChat(
          account,
          canonical,
          chat.name as string | null,
          Number(chat.ts),
          Number(chat.unread),
        );
        this.db
          .prepare("DELETE FROM chats WHERE account=? AND jid=?")
          .run(account, alias);
      }
      for (const r of this.db
        .prepare("SELECT * FROM receipts WHERE account=? AND chat=?")
        .all(account, alias) as Row[])
        this.receipt(
          account,
          { id: String(r.id), remoteJid: canonical },
          String(r.status),
          String(r.participant),
        );
      this.db
        .prepare("DELETE FROM receipts WHERE account=? AND chat=?")
        .run(account, alias);
    });
  }
  saveContact(
    account: string,
    jid: string,
    name: string | null,
    phone: string | null = null,
    lid: string | null = null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO contacts VALUES(?,?,?,?,?) ON CONFLICT(account,jid) DO UPDATE SET name=COALESCE(excluded.name,contacts.name),phone=COALESCE(excluded.phone,contacts.phone),lid=COALESCE(excluded.lid,contacts.lid)",
      )
      .run(account, jid, name, phone, lid);
    if (lid && (phone || jid.endsWith("@s.whatsapp.net")))
      this.alias(account, phone ?? jid, lid);
  }
  contacts(
    account: string,
    query: string,
    limit: number,
    offset: number,
  ): Row[] {
    return this.db
      .prepare(
        "SELECT jid,name,phone,lid FROM contacts WHERE account=? AND (name LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') ORDER BY name,jid LIMIT ? OFFSET ?",
      )
      .all(
        account,
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        limit,
        offset,
      ) as Row[];
  }
  saveChat(
    account: string,
    jid: string,
    name: string | null,
    ts = 0,
    unread?: number,
  ): void {
    jid = this.canonical(account, jid);
    this.db
      .prepare(
        "INSERT INTO chats VALUES(?,?,?,?,?,COALESCE(?,0)) ON CONFLICT(account,jid) DO UPDATE SET name=COALESCE(excluded.name,chats.name),ts=MAX(chats.ts,excluded.ts),unread=COALESCE(?,chats.unread)",
      )
      .run(
        account,
        jid,
        name,
        jid.endsWith("@g.us") ? "group" : "direct",
        ts,
        unread ?? null,
        unread ?? null,
      );
  }
  chats(account: string, limit: number, offset: number): Row[] {
    return this.db
      .prepare(
        "SELECT jid,name,kind,ts,unread FROM chats WHERE account=? ORDER BY ts DESC,jid LIMIT ? OFFSET ?",
      )
      .all(account, limit, offset) as Row[];
  }
  saveMessage(account: string, m: StoredMessage): void {
    const chat = this.canonical(account, m.chatId);
    this.db
      .prepare(
        "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account,id,chat,from_me) DO UPDATE SET raw=excluded.raw,text=excluded.text,type=excluded.type",
      )
      .run(
        account,
        m.id,
        chat,
        Number(m.fromMe),
        m.timestamp,
        m.type,
        m.text,
        m.status,
        this.seal(m, `message:${account}:${m.id}:${chat}:${Number(m.fromMe)}`),
      );
    this.saveChat(account, chat, null, m.timestamp);
    if (m.fromMe) this.advanceStatus(account, m.id, chat, m.status);
    const receipt = this.db
      .prepare(
        "SELECT status FROM receipts WHERE account=? AND id=? AND chat=? AND participant=''",
      )
      .get(account, m.id, chat) as Row | undefined;
    if (m.fromMe && receipt)
      this.advanceStatus(account, m.id, chat, String(receipt.status));
  }
  messages(
    account: string,
    options: {
      chat?: string;
      id?: string;
      fromMe?: boolean;
      before?: number;
      limit: number;
      offset: number;
    },
  ): StoredMessage[] {
    let sql = "SELECT * FROM messages WHERE account=?";
    const args: any[] = [account];
    if (options.chat) {
      sql +=
        " AND (chat=? OR chat IN (SELECT alias FROM aliases WHERE account=? AND canonical=?))";
      const c = this.canonical(account, options.chat);
      args.push(c, account, c);
    }
    if (options.id) {
      sql += " AND id=?";
      args.push(options.id);
    }
    if (options.fromMe !== undefined) {
      sql += " AND from_me=?";
      args.push(Number(options.fromMe));
    }
    if (options.before !== undefined) {
      sql += " AND ts<?";
      args.push(options.before);
    }
    sql += " ORDER BY ts DESC,id DESC LIMIT ? OFFSET ?";
    args.push(options.limit, options.offset);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      ...this.open(
        r.raw as Uint8Array,
        `message:${account}:${r.id}:${r.chat}:${r.from_me}`,
      ),
      status: String(r.status),
    }));
  }
  private advanceStatus(
    account: string,
    id: string,
    chat: string,
    status: string,
  ): void {
    const rank = (s: string) =>
      [
        "ERROR",
        "PENDING",
        "SERVER_ACK",
        "DELIVERY_ACK",
        "READ",
        "PLAYED",
      ].indexOf(s);
    for (const row of this.db
      .prepare(
        "SELECT status FROM messages WHERE account=? AND id=? AND chat=? AND from_me=1",
      )
      .all(account, id, chat) as Row[])
      if (rank(status) > rank(String(row.status)))
        this.db
          .prepare(
            "UPDATE messages SET status=? WHERE account=? AND id=? AND chat=? AND from_me=1",
          )
          .run(status, account, id, chat);
  }
  receipt(
    account: string,
    key: { id: string; remoteJid?: string; fromMe?: boolean },
    status: string,
    participant = "",
  ): void {
    if (!key.id || !key.remoteJid || key.fromMe === false) return;
    const chat = this.canonical(account, key.remoteJid),
      rank = (s: string) =>
        [
          "ERROR",
          "PENDING",
          "SERVER_ACK",
          "DELIVERY_ACK",
          "READ",
          "PLAYED",
        ].indexOf(s);
    const previous = this.db
      .prepare(
        "SELECT status FROM receipts WHERE account=? AND id=? AND chat=? AND participant=?",
      )
      .get(account, key.id, chat, participant) as Row | undefined;
    if (!previous || rank(status) > rank(String(previous.status)))
      this.db
        .prepare("INSERT OR REPLACE INTO receipts VALUES(?,?,?,?,?,?)")
        .run(account, key.id, chat, participant, status, Date.now());
    if (!participant || !chat.endsWith("@g.us"))
      this.advanceStatus(account, key.id, chat, status);
  }
  receipts(account: string, id: string): Row[] {
    return this.db
      .prepare(
        "SELECT id,chat,participant,status,updated FROM receipts WHERE account=? AND id=? ORDER BY chat,participant",
      )
      .all(account, id) as Row[];
  }
  acquireLease(owner: string): number {
    return this.transaction(() => {
      const r = this.db.prepare("SELECT * FROM lease WHERE id=1").get() as
        Row | undefined;
      if (r && Number(r.expires) > Date.now() && r.owner !== owner)
        throw new Error("Another service owns this data directory");
      const fence = Number(r?.fence ?? 0) + 1;
      this.db
        .prepare("INSERT OR REPLACE INTO lease VALUES(1,?,?,?)")
        .run(owner, Date.now() + 20000, fence);
      this.lease = { owner, fence };
      return fence;
    });
  }
  heartbeat(): void {
    this.assertLease();
    this.db
      .prepare("UPDATE lease SET expires=? WHERE id=1 AND owner=? AND fence=?")
      .run(Date.now() + 20000, this.lease!.owner, this.lease!.fence);
  }
  assertLease(): void {
    const r = this.db.prepare("SELECT * FROM lease WHERE id=1").get() as
      Row | undefined;
    if (
      !this.lease ||
      !r ||
      r.owner !== this.lease.owner ||
      Number(r.fence) !== this.lease.fence ||
      Number(r.expires) <= Date.now()
    )
      throw new Error("Service writer lease lost");
  }
  releaseLease(): void {
    if (this.lease)
      this.db
        .prepare(
          "UPDATE lease SET expires=0 WHERE id=1 AND owner=? AND fence=?",
        )
        .run(this.lease.owner, this.lease.fence);
    this.lease = undefined;
  }
  close(): void {
    this.releaseLease();
    this.db.close();
  }
}
