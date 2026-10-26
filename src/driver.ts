import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";

export type EventBatch = Record<string, any>;
export interface SocketPort {
  user(): { id: string; name?: string } | undefined;
  close(): Promise<void>;
  logout(): Promise<void>;
  send(jid: string, content: any, messageId: string): Promise<any>;
  check(numbers: string[]): Promise<any[]>;
  groups(): Promise<Record<string, any>>;
  group(jid: string): Promise<any>;
  media(raw: any): Promise<AsyncIterable<Uint8Array>>;
}
export interface DriverOptions {
  auth: AuthenticationState;
  onEvents: (events: EventBatch) => Promise<void>;
  getMessage: (key: any) => Promise<any>;
  onError: (error: unknown) => void;
}
export type DriverFactory = (options: DriverOptions) => Promise<SocketPort>;
export { initAuthCreds, proto, DisconnectReason };
export const baileysDriver: DriverFactory = async (options) => {
  const logger = pino({ level: "silent" });
  const sock = makeWASocket({
    auth: options.auth,
    logger: logger as any,
    browser: Browsers.ubuntu("WhatsApp MCP"),
    qrTimeout: 45000,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    getMessage: options.getMessage,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) =>
      jid === "status@broadcast" || jid.endsWith("@newsletter"),
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000,
  });
  sock.ev.process(async (events) => {
    try {
      await options.onEvents(events);
    } catch (error) {
      options.onError(error);
    }
  });
  return {
    user: () => sock.user,
    async close() {
      sock.end(undefined);
      const deadline = Date.now() + 5000;
      while (!sock.ws.isClosed && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      if (!sock.ws.isClosed) throw new Error("WhatsApp socket did not close");
    },
    async logout() {
      await sock.logout();
    },
    send: (jid, content, messageId) =>
      sock.sendMessage(jid, content, { messageId }),
    check: async (numbers) => (await sock.onWhatsApp(...numbers)) ?? [],
    groups: () => sock.groupFetchAllParticipating(),
    group: (jid) => sock.groupMetadata(jid),
    media: async (raw) =>
      await downloadMediaMessage(
        raw as WAMessage,
        "stream",
        {},
        { logger: logger as any, reuploadRequest: sock.updateMediaMessage },
      ),
  };
};
