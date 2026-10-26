import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { loadConfig, initialize } from "../dist/config.js";
import { fixture, message } from "./helpers.mjs";
test("private initialization is repeatable and validates deployment configuration", (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.dir, "master.key"));
  initialize(f.dir);
  assert.deepEqual(readFileSync(join(f.dir, "master.key")), before);
  assert.equal(statSync(join(f.dir, "admin.token")).mode & 0o077, 0);
  assert.throws(
    () =>
      loadConfig({ WA_DATA_DIR: f.dir, WA_PUBLIC_URL: "http://example.com" }),
    /HTTPS/,
  );
  assert.throws(
    () => loadConfig({ WA_DATA_DIR: f.dir, WA_MAX_MEDIA_BYTES: "999999999" }),
    /MiB/,
  );
});
test("encrypted auth is durable, preserves binary data and binds ciphertext to its account", (t) => {
  const f = fixture(t),
    a = f.store.createAccount("A"),
    b = f.store.createAccount("B");
  const value = {
    secret: "not-plaintext",
    buffer: Buffer.from([1, 2, 3]),
    array: new Uint8Array([4, 5]),
  };
  f.store.put("auth", a.id, "creds", value);
  const reopened = new Store(
    join(f.dir, "whatsapp.sqlite"),
    f.config.masterKey,
  );
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get("auth", a.id, "creds").buffer, value.buffer);
  assert.deepEqual(
    reopened.get("auth", a.id, "creds").array,
    Buffer.from(value.array),
  );
  assert.equal(reopened.get("auth", b.id, "creds"), undefined);
  const row = f.store.db
    .prepare("SELECT data FROM slots WHERE account=? AND id='creds'")
    .get(a.id);
  assert(!Buffer.from(row.data).includes(Buffer.from(value.secret)));
  f.store.db
    .prepare(
      "INSERT INTO slots SELECT kind,?,id,data,expires,updated FROM slots WHERE account=? AND id='creds'",
    )
    .run(b.id, a.id);
  assert.throws(() => f.store.get("auth", b.id, "creds"));
});
test("writer lease fences a second daemon and a previous owner after expiry", (t) => {
  const f = fixture(t),
    other = new Store(join(f.dir, "whatsapp.sqlite"), f.config.masterKey);
  t.after(() => other.close());
  assert.throws(() => other.acquireLease("second"), /Another service/);
  f.store.db.exec("UPDATE lease SET expires=0");
  other.acquireLease("second");
  assert.throws(() => f.store.assertLease(), /lost/);
  other.heartbeat();
});
test("PN/LID aliases merge late history without changing original message identity or crossing accounts", (t) => {
  const f = fixture(t),
    a = f.store.createAccount("A"),
    b = f.store.createAccount("B"),
    pn = "15550000002@s.whatsapp.net",
    lid = "opaque@lid";
  f.sessions.ingest(a.id, message("same-id", pn));
  f.sessions.ingest(b.id, message("same-id", pn, false, "Other account"));
  f.store.alias(a.id, pn, lid);
  f.sessions.ingest(a.id, {
    ...message("same-id", pn),
    key: { id: "same-id", remoteJid: pn, remoteJidAlt: lid, fromMe: false },
  });
  assert.equal(f.store.chats(a.id, 10, 0).length, 1);
  const rows = f.store.messages(a.id, { chat: lid, limit: 10, offset: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chatId, pn);
  assert.equal(rows[0].remoteJidAlt, lid);
  assert.equal(
    f.store.messages(b.id, { chat: pn, limit: 10, offset: 0 })[0].text,
    "Other account",
  );
  assert.equal(
    f.store.messages(b.id, { chat: lid, limit: 10, offset: 0 }).length,
    0,
  );
  f.store.saveContact(a.id, pn, "50% _literal");
  assert.equal(f.store.contacts(a.id, "%", 10, 0).length, 1);
  assert.equal(f.store.contacts(a.id, "nomatch", 10, 0).length, 0);
});
test("receipts are monotonic, survive arriving first, and target outgoing identity and group participant", (t) => {
  const f = fixture(t),
    a = f.store.createAccount("A"),
    chat = "15550000002@s.whatsapp.net",
    key = { id: "id", remoteJid: chat, fromMe: true };
  f.store.receipt(a.id, key, "READ");
  f.sessions.ingest(a.id, message("id", chat, true));
  f.sessions.ingest(a.id, message("id", chat, false));
  f.sessions.ingest(a.id, message("id", "15550000003@s.whatsapp.net", true));
  f.store.receipt(a.id, key, "SERVER_ACK");
  const rows = f.store.messages(a.id, { chat, id: "id", limit: 10, offset: 0 });
  assert.equal(rows.find((m) => m.fromMe).status, "READ");
  assert.equal(rows.find((m) => !m.fromMe).status, "RECEIVED");
  assert.equal(
    f.store.messages(a.id, {
      chat: "15550000003@s.whatsapp.net",
      limit: 1,
      offset: 0,
    })[0].status,
    "PENDING",
  );
  const group = "120000000000@g.us";
  f.sessions.ingest(a.id, message("group-id", group, true));
  f.store.receipt(
    a.id,
    { id: "group-id", remoteJid: group },
    "READ",
    "participant@lid",
  );
  assert.equal(
    f.store.messages(a.id, { id: "group-id", limit: 1, offset: 0 })[0].status,
    "PENDING",
  );
  assert.equal(
    f.store.receipts(a.id, "group-id")[0].participant,
    "participant@lid",
  );
});
