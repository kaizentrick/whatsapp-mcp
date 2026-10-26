#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { dataDirectory, initialize, loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Access, type Permission } from "./access.js";
import { Service } from "./service.js";

process.umask(0o077);
function flag(name: string): string | undefined {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
async function main() {
  const command = process.argv[2] ?? "serve";
  if (["help", "--help", "-h"].includes(command)) {
    console.log(
      `WhatsApp MCP\n\nCommands:\n  init                 Generate private keys in WA_DATA_DIR\n  serve                Run the persistent service (default)\n  stdio                Bridge an agent to WA_SERVER_URL\n  account:create       --name NAME\n  account:list\n  token:create         --account NAME --permissions read,send --days 30 --out FILE\n  token:revoke          --id TOKEN_ID\n\nSee README.md and docs/ for HTTPS, Docker and agent configuration.`,
    );
    return;
  }
  if (command === "init") {
    const dir = dataDirectory();
    initialize(dir);
    console.log(
      `Initialized ${dir}\nOwner access key: ${join(dir, "admin.token")}\nEncryption key: ${join(dir, "master.key")}\nKeep both private and include them in backups.`,
    );
    return;
  }
  if (command === "stdio") {
    const token =
      process.env.WA_CLIENT_TOKEN ??
      readFileSync(
        process.env.WA_CLIENT_TOKEN_FILE ??
          join(dataDirectory(), "admin.token"),
        "utf8",
      ).trim();
    const url =
      (
        process.env.WA_SERVER_URL ??
        `http://127.0.0.1:${process.env.WA_PORT ?? 8787}`
      ).replace(/\/+$/, "") + "/mcp";
    const endpoint = new URL(url);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
        ))
    )
      throw new Error(
        "WA_SERVER_URL must use HTTPS, or HTTP on loopback, without credentials or query parameters",
      );
    const client = new Client(
      { name: "whatsapp-mcp-stdio", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    const server = new Server(
      { name: "whatsapp-mcp", version: "0.1.0" },
      { capabilities: { tools: {} }, instructions: client.getInstructions() },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
    server.setRequestHandler(CallToolRequestSchema, (req) =>
      client.callTool(req.params),
    );
    const stop = async () => {
      await server.close();
      await client.close();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    await server.connect(new StdioServerTransport());
    server.onclose = () => void client.close();
    return;
  }
  const config = loadConfig();
  if (command === "serve") {
    const service = new Service(config);
    await service.start();
    console.error(
      `WhatsApp MCP listening on ${config.host}:${config.port}; data ${config.dataDir}`,
    );
    const stop = () => {
      void service
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  const store = new Store(
    join(config.dataDir, "whatsapp.sqlite"),
    config.masterKey,
  );
  try {
    if (command === "account:create") {
      const name = flag("name");
      if (!name) throw new Error("Use account:create --name NAME");
      console.log(JSON.stringify(store.createAccount(name)));
    } else if (command === "account:list")
      console.log(JSON.stringify(store.accounts(), null, 2));
    else if (command === "token:create") {
      const account = flag("account"),
        out = flag("out");
      if (!account || !out)
        throw new Error(
          "Use token:create --account NAME --permissions read,send --out /private/path/client.token",
        );
      const permissions = (flag("permissions") ?? "read").split(
        ",",
      ) as Permission[];
      const value = new Access(store, config).issue(
        account,
        permissions,
        Number(flag("days") ?? 30),
      );
      mkdirSync(resolve(out, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(out, value.token + "\n", { mode: 0o600, flag: "wx" });
      console.log(
        JSON.stringify({
          id: value.id,
          expiresAt: value.expiresAt,
          tokenFile: resolve(out),
        }),
      );
    } else if (command === "token:revoke") {
      const id = flag("id");
      if (!id) throw new Error("Use token:revoke --id TOKEN_ID");
      new Access(store, config).revoke(id);
      console.log("Access key revoked.");
    } else
      throw new Error(
        "Commands: init, serve, stdio, account:create, account:list, token:create, token:revoke",
      );
  } finally {
    store.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
