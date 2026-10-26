import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initialize, loadConfig } from "../dist/config.js";
import { Store } from "../dist/store.js";
import { Sessions } from "../dist/sessions.js";
import { Access } from "../dist/access.js";
import { Tools } from "../dist/mcp.js";
export function fakeDriver() {
  const sockets = [];
  const factory = async (options) => {
    const state = {
      options,
      closed: false,
      loggedOut: false,
      sends: [],
      self: "15550000001:2@s.whatsapp.net",
      sendError: null,
      delay: 0,
    };
    const socket = {
      user: () => ({ id: state.self, name: "Test account" }),
      close: async () => {
        state.closed = true;
      },
      logout: async () => {
        state.loggedOut = true;
      },
      send: async (jid, content, messageId) => {
        state.sends.push({ jid, content, messageId });
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        if (state.sendError) throw state.sendError;
        return {
          key: { id: messageId, remoteJid: jid, fromMe: true },
          messageTimestamp: 1000,
          message: { conversation: content.text ?? "Attachment" },
        };
      },
      check: async (numbers) =>
        numbers.map((n) => ({
          exists: n !== "15550000000",
          jid: n + "@s.whatsapp.net",
        })),
      groups: async () => ({
        "120000000000@g.us": {
          id: "120000000000@g.us",
          subject: "Test group",
          participants: [{ id: "opaque@lid" }],
        },
      }),
      group: async (jid) => ({
        id: jid,
        subject: "Test group",
        desc: "Untrusted description",
        participants: [
          {
            id: "opaque@lid",
            phoneNumber: "15550000002@s.whatsapp.net",
            admin: null,
          },
        ],
      }),
      media: async () =>
        (async function* () {
          yield Buffer.from("test-media");
        })(),
    };
    state.emit = (events) => options.onEvents(events);
    state.socket = socket;
    sockets.push(state);
    return socket;
  };
  return { factory, sockets };
}
export function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-mcp-test-"));
  initialize(dir);
  const config = {
    ...loadConfig({ WA_DATA_DIR: dir, WA_PORT: "0", WA_AUTO_START: "false" }),
    ...overrides,
  };
  const store = new Store(join(dir, "whatsapp.sqlite"), config.masterKey);
  store.acquireLease(randomUUID());
  const fake = fakeDriver(),
    sessions = new Sessions(store, fake.factory, config.maxMediaBytes),
    access = new Access(store, config),
    tools = new Tools(store, sessions);
  t.after(async () => {
    await sessions.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, store, fake, sessions, access, tools };
}
export async function connected(f, name = "A", number = "15550000001") {
  const account = f.store.createAccount(name);
  await f.sessions.start(account.id);
  const socket = f.fake.sockets.at(-1);
  socket.self = number + ":2@s.whatsapp.net";
  await socket.emit({ "connection.update": { connection: "open" } });
  return { account: f.store.account(account.id), socket };
}
export const textResult = (r) =>
  JSON.parse(r.content.find((c) => c.type === "text").text);
export const message = (
  id,
  chat = "15550000002@s.whatsapp.net",
  fromMe = false,
  text = "Hello",
) => ({
  key: { id, remoteJid: chat, fromMe },
  messageTimestamp: 1000,
  message: { conversation: text },
});
