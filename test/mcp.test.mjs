import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, loadConfig } from "../dist/config.js";
import { Service } from "../dist/service.js";
import { fixture, connected, textResult, fakeDriver } from "./helpers.mjs";
test("account keys filter discovery and enforce read/send/manage boundaries on direct calls", async (t) => {
  const f = fixture(t),
    { account } = await connected(f),
    other = f.store.createAccount("Other");
  const issued = f.access.issue(account.id, ["read"]),
    p = f.access.identify(issued.token);
  assert(p);
  assert.equal(f.tools.visible(p).length, 13);
  assert(!f.tools.visible(p).some((s) => s.name === "whatsapp_message_send"));
  assert.equal(
    textResult(await f.tools.execute("whatsapp_account_list", {}, p)).accounts
      .length,
    1,
  );
  assert(
    (await f.tools.execute("whatsapp_account_status", { account: other.id }, p))
      .isError,
  );
  assert(
    (
      await f.tools.execute(
        "whatsapp_message_send",
        {
          account: account.id,
          to: "15550000099",
          text: "No permission",
          requestId: "request-denied-0001",
        },
        p,
      )
    ).isError,
  );
  const sender = f.access.identify(
    f.access.issue(account.id, ["read", "send"]).token,
  );
  assert(
    !f.tools.visible(sender).some((s) => s.name === "whatsapp_pairing_start"),
  );
  assert(
    !f.tools.visible(sender).some((s) => s.name === "whatsapp_account_create"),
  );
  const manager = f.access.identify(
    f.access.issue(account.id, ["read", "send", "manage"]).token,
  );
  assert.equal(f.tools.visible(manager).length, 19);
  assert(
    (
      await f.tools.execute(
        "whatsapp_account_logout",
        { account: account.id },
        manager,
      )
    ).isError,
  );
  const profile = textResult(
    await f.tools.execute("whatsapp_profile_get", {}, p),
  );
  assert.equal(profile.id, account.profileId);
  f.access.revoke(issued.id);
  assert.equal(f.access.identify(issued.token), null);
  assert.equal(f.access.resolve(p), null);
});
test("HTTP and stdio speak standard MCP, share one daemon, and expose no account data anonymously", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wa-mcp-http-"));
  initialize(dir);
  const config = loadConfig({
      WA_DATA_DIR: dir,
      WA_PORT: "0",
      WA_AUTO_START: "false",
    }),
    fake = fakeDriver(),
    service = new Service(config, fake.factory);
  await service.start();
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = service.address();
  assert.equal(
    (
      await fetch(base + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.deepEqual(await (await fetch(base + "/health")).json(), {
    status: "ok",
    version: "0.1.0",
  });
  const page = await fetch(base + "/");
  assert(
    page.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  assert((await page.text()).includes("Linked devices"));
  assert(
    !(await (await fetch(base + "/admin.js")).text()).includes("localStorage"),
  );
  const client = new Client({ name: "Test agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + config.adminToken },
      },
    }),
  );
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 20);
  const a = textResult(
    await client.callTool({
      name: "whatsapp_account_create",
      arguments: { name: "HTTP account" },
    }),
  );
  assert(a.id);
  const profile = textResult(
    await client.callTool({ name: "whatsapp_profile_get" }),
  );
  assert.equal(profile.id, service.access.ownerProfileId);
  const token = service.access.issue(a.id, ["read"]),
    path = join(dir, "client.token");
  writeFileSync(path, token.token, { mode: 0o600 });
  const stdio = new Client({ name: "Generic stdio agent", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "stdio"],
      env: {
        PATH: process.env.PATH,
        WA_CLIENT_TOKEN_FILE: path,
        WA_SERVER_URL: base,
      },
      stderr: "pipe",
    });
  await stdio.connect(transport);
  t.after(() => stdio.close());
  assert.equal((await stdio.listTools()).tools.length, 13);
  assert.equal(
    textResult(await stdio.callTool({ name: "whatsapp_account_list" }))
      .accounts[0].id,
    a.id,
  );
  assert.equal(fake.sockets.length, 0);
  const forbidden = await fetch(base + "/api/tools/list", {
    headers: {
      Authorization: "Bearer " + token.token,
      Origin: "https://evil.example",
    },
  });
  assert.equal(forbidden.status, 403);
  service.access.revoke(token.id);
  await assert.rejects(() => stdio.listTools());
  await stdio.close();
  await client.close();
});
