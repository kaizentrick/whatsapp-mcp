// Optional network smoke test. Never sends a message or prints the QR payload.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../dist/store.js";
import { Sessions } from "../dist/sessions.js";
const dir = mkdtempSync(join(tmpdir(), "wa-live-qr-")),
  store = new Store(join(dir, "state.sqlite"), randomBytes(32));
store.acquireLease(randomUUID());
const sessions = new Sessions(store),
  a = store.createAccount("Disposable QR smoke");
const heartbeat = setInterval(() => store.heartbeat(), 5000);
try {
  await sessions.start(a.id);
  const deadline = Date.now() + 45000;
  while (!sessions.qr(a.id) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 250));
  const qr = sessions.qr(a.id);
  if (!qr) throw new Error("No QR received: " + store.account(a.id).state);
  console.log(
    JSON.stringify({
      result: "qr_received",
      generation: qr.generation,
      expiresInMs: qr.expiresAt - Date.now(),
      messagesSent: 0,
    }),
  );
} finally {
  clearInterval(heartbeat);
  await sessions.shutdown();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
