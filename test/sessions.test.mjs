import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DisconnectReason } from "../dist/driver.js";
import { fixture, connected, message } from "./helpers.mjs";
test("concurrent starts share one socket, persist Signal keys, expire QR, and ignore a previous generation", async (t) => {
  const f = fixture(t),
    a = f.store.createAccount("A");
  await Promise.all([f.sessions.start(a.id), f.sessions.start("A")]);
  assert.equal(f.fake.sockets.length, 1);
  const old = f.fake.sockets[0];
  await old.options.auth.keys.set({
    session: { signal: Buffer.from("binary") },
  });
  assert.deepEqual(
    (await old.options.auth.keys.get("session", ["signal"])).signal,
    Buffer.from("binary"),
  );
  await old.emit({ "connection.update": { qr: "qr-one" } });
  const first = f.sessions.qr(a.id);
  await old.emit({ "connection.update": { qr: "qr-two" } });
  assert(f.sessions.qr(a.id).generation > first.generation);
  assert.equal(
    f.sessions.qr(a.id).expiresAt - f.sessions.qr(a.id).createdAt,
    43000,
  );
  await f.sessions.disconnect(a.id);
  assert.equal(f.sessions.qr(a.id), null);
  await f.sessions.start(a.id);
  await old.emit({ "connection.update": { qr: "stale" } });
  assert.equal(f.sessions.qr(a.id), null);
  await assert.rejects(
    () => old.options.auth.keys.set({ session: { stale: Buffer.from("bad") } }),
    /Stale/,
  );
  assert.deepEqual(
    (await f.fake.sockets[1].options.auth.keys.get("session", ["signal"]))
      .signal,
    Buffer.from("binary"),
  );
});
test("restartRequired reconnects once; replaced connections stop; logged-out credentials are erased", async (t) => {
  const f = fixture(t),
    { account, socket } = await connected(f);
  await socket.emit({
    "connection.update": {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.restartRequired } },
      },
    },
  });
  await delay(320);
  assert.equal(f.fake.sockets.length, 2);
  assert(socket.closed);
  const next = f.fake.sockets[1];
  await next.emit({
    "connection.update": {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.connectionReplaced } },
      },
    },
  });
  assert.equal(f.store.account(account.id).state, "replaced");
  assert.equal(f.store.account(account.id).autoStart, false);
  await f.sessions.start(account.id);
  const last = f.fake.sockets.at(-1);
  await last.options.auth.keys.set({ session: { test: Buffer.from("erase") } });
  await last.emit({
    "connection.update": {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.loggedOut } },
      },
    },
  });
  assert.equal(f.store.get("auth", account.id, "session:test"), undefined);
  assert.equal(f.store.account(account.id).state, "logged_out");
});
test("pairing another number cannot inherit a previous account history or credentials", async (t) => {
  const f = fixture(t),
    { account } = await connected(f);
  await f.sessions.disconnect(account.id);
  await f.sessions.start(account.id);
  const socket = f.fake.sockets.at(-1);
  socket.self = "15550000099:1@s.whatsapp.net";
  await socket.emit({
    "connection.update": { connection: "open" },
    "messages.upsert": { messages: [message("should-not-ingest")] },
  });
  assert.equal(f.store.account(account.id).state, "identity_mismatch");
  assert.equal(
    f.store.account(account.id).selfJid,
    "15550000001@s.whatsapp.net",
  );
  assert.equal(
    f.store.messages(account.id, { limit: 10, offset: 0 }).length,
    0,
  );
  assert.equal(f.store.account(account.id).autoStart, false);
});
test("same requestId sends once even concurrently; changed payload and unknown outcomes cannot resend", async (t) => {
  const f = fixture(t),
    { account, socket } = await connected(f);
  socket.delay = 15;
  const id = "request-unique-0001";
  const [a, b] = await Promise.all([
    f.sessions.send(account.id, "15550000099", id, {
      text: "Hello unsaved number",
    }),
    f.sessions.send(account.id, "15550000099", id, {
      text: "Hello unsaved number",
    }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(socket.sends.length, 1);
  assert.equal(socket.sends[0].jid, "15550000099@s.whatsapp.net");
  await f.sessions.send(account.id, "15550000099", id, {
    text: "Hello unsaved number",
  });
  assert.equal(socket.sends.length, 1);
  await assert.rejects(
    () => f.sessions.send(account.id, "15550000099", id, { text: "Different" }),
    /different message/,
  );
  socket.sendError = new Error("Network lost after send");
  await assert.rejects(
    () =>
      f.sessions.send(account.id, "15550000099", "request-unique-0002", {
        text: "Uncertain",
      }),
    /unknown/,
  );
  await assert.rejects(
    () =>
      f.sessions.send(account.id, "15550000099", "request-unique-0002", {
        text: "Uncertain",
      }),
    /unknown/,
  );
  assert.equal(socket.sends.length, 2);
  await assert.rejects(
    () =>
      f.sessions.send(account.id, "15550000000", "request-unique-0003", {
        text: "Not registered on WhatsApp",
      }),
    /not registered/,
  );
  assert.equal(
    f.store.get("outbox", account.id, "request-unique-0003").state,
    "rejected",
  );
  assert.equal(socket.sends.length, 2);
});
test("self sends, group identifiers, bounded media and status enums use the same persistent account", async (t) => {
  const f = fixture(t, { maxMediaBytes: 20 }),
    { account, socket } = await connected(f);
  const self = await f.sessions.send(
    account.id,
    "15550000001",
    "request-self-0001",
    { text: "Self" },
  );
  assert.equal(socket.sends[0].jid, account.selfJid);
  await socket.emit({
    "messages.update": [
      {
        key: { id: self.messageId, remoteJid: account.selfJid, fromMe: true },
        update: { status: 3 },
      },
    ],
  });
  assert.equal(
    f.store.messages(account.id, { id: self.messageId, limit: 1, offset: 0 })[0]
      .status,
    "DELIVERY_ACK",
  );
  await f.sessions.send(account.id, "120000000000@g.us", "request-group-0001", {
    text: "Group",
  });
  assert.equal(socket.sends[1].jid, "120000000000@g.us");
  await assert.rejects(
    () =>
      f.sessions.send(account.id, "15550000099", "request-media-0001", {
        media: {
          kind: "document",
          mimeType: "text/plain",
          base64: Buffer.alloc(30).toString("base64"),
        },
      }),
    /limit/,
  );
  assert.equal(socket.sends.length, 2);
  f.sessions.ingest(account.id, message("attachment"));
  assert.equal(
    (await f.sessions.media(account.id, "attachment")).toString(),
    "test-media",
  );
});
