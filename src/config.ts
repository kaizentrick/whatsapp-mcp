import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  publicUrl: string;
  masterKey: Buffer;
  adminToken: string;
  maxMediaBytes: number;
  autoStart: boolean;
}
export function dataDirectory(env = process.env): string {
  return resolve(
    env.WA_DATA_DIR ??
      join(
        env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        "whatsapp-mcp",
      ),
  );
}
export function initialize(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const name of ["master.key", "admin.token"]) {
    const p = join(dataDir, name);
    if (!existsSync(p))
      writeFileSync(p, randomBytes(32).toString("hex") + "\n", {
        mode: 0o600,
        flag: "wx",
      });
  }
}
function privateFile(path: string): string {
  if (process.platform !== "win32" && statSync(path).mode & 0o077)
    throw new Error(`Restrict permissions to owner only: ${path}`);
  return readFileSync(path, "utf8").trim();
}
export function loadConfig(env = process.env): Config {
  const dataDir = dataDirectory(env);
  const masterHex =
    env.WA_MASTER_KEY ?? privateFile(join(dataDir, "master.key"));
  if (!/^[a-fA-F0-9]{64}$/.test(masterHex))
    throw new Error(
      "The encryption key must be exactly 64 hexadecimal characters",
    );
  const masterKey = Buffer.from(masterHex, "hex");
  const adminToken =
    env.WA_ADMIN_TOKEN ?? privateFile(join(dataDir, "admin.token"));
  if (masterKey.length !== 32 || !/^[\x21-\x7e]{32,512}$/.test(adminToken))
    throw new Error("Initialize 32-byte keys with whatsapp-mcp init");
  const port = Number(env.WA_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("WA_PORT must be a valid TCP port");
  const publicUrl = (env.WA_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    "",
  );
  const url = new URL(publicUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "WA_PUBLIC_URL must be an origin without a path or credentials",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Remote access requires an HTTPS WA_PUBLIC_URL");
  const host = env.WA_HOST ?? "127.0.0.1";
  const maxMediaBytes = Number(env.WA_MAX_MEDIA_BYTES ?? 5 * 1024 * 1024);
  if (
    !Number.isSafeInteger(maxMediaBytes) ||
    maxMediaBytes < 1 ||
    maxMediaBytes > 25 * 1024 * 1024
  )
    throw new Error("WA_MAX_MEDIA_BYTES must be between 1 and 25 MiB");
  return {
    dataDir,
    host,
    port,
    publicUrl,
    masterKey,
    adminToken,
    maxMediaBytes,
    autoStart: env.WA_AUTO_START !== "false",
  };
}
