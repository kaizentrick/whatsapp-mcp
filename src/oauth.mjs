import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import {
  randomBytes,
  randomUUID,
  createHash,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import express from "express";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const SCOPES = ["whatsapp:read", "whatsapp:send", "whatsapp:manage"];
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString("base64url");
export const digest = (s) => createHash("sha256").update(s).digest("hex");
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

class Store {
  constructor(file, secret) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "whatsapp-mcp-oauth", "database-v1", 32),
    );
    this.db = new DatabaseSync(file);
    if (file !== ":memory:" && process.platform !== "win32")
      chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,expires INTEGER,PRIMARY KEY(kind,id))",
    );
  }
  get(kind, id) {
    const r = this.db
      .prepare("SELECT data,expires FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    if (!r || (r.expires && r.expires <= now())) return undefined;
    const b = Buffer.from(r.data, "base64");
    const dec = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    dec.setAAD(Buffer.from(`${kind}:${id}`));
    dec.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString(),
    );
  }
  set(kind, id, data, expires = 0) {
    const iv = randomBytes(12),
      enc = createCipheriv("aes-256-gcm", this.key, iv);
    enc.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([
      enc.update(JSON.stringify(data)),
      enc.final(),
    ]);
    const value = Buffer.concat([iv, enc.getAuthTag(), encrypted]).toString(
      "base64",
    );
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)")
      .run(kind, id, value, expires);
  }
  delete(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  transaction(fn) {
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
  clean() {
    this.db
      .prepare("DELETE FROM records WHERE expires>0 AND expires<?")
      .run(now());
  }
}

export function createOAuth({
  config,
  adminToken,
  identify,
  resolvePrincipal,
  storePath,
}) {
  const ORIGIN = config.publicUrl;
  const RESOURCE = ORIGIN + "/mcp";
  const issuer = new URL(ORIGIN);
  const challenge = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(" ")}"`;
  const store = new Store(storePath, config.masterKey);
  const authForOwner = () => ({
    role: "owner",
    profileId: config.ownerProfileId,
    name: "All WhatsApp accounts",
    credentialHash: digest(config.adminToken),
    permissions: ["read", "send", "manage"],
  });
  const resourceOk = (resource) => !resource || resource.href === RESOURCE;
  const getGrant = (kind, token, client) => {
    const record = store.get(kind, digest(token));
    if (!record || (client && record.clientId !== client.client_id))
      throw new InvalidGrantError("Invalid or expired grant");
    const grant = store.get("grant", record.grantId);
    if (!grant || grant.revoked)
      throw new InvalidGrantError("Grant has been revoked");
    return { record, grant };
  };
  const issue = (grantId, grant) => {
    const access = random(),
      refresh = random();
    store.set(
      "access",
      digest(access),
      { grantId, clientId: grant.clientId },
      now() + 3600,
    );
    store.set(
      "refresh",
      digest(refresh),
      { grantId, clientId: grant.clientId },
      grant.expires,
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    };
  };
  const provider = {
    clientsStore: {
      getClient(id) {
        return store.get("client", id);
      },
      registerClient(client) {
        if (!client.redirect_uris?.length || client.redirect_uris.length > 10)
          throw new InvalidClientMetadataError("Specify valid redirect URIs");
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
            u.hostname,
          );
          if (
            (u.protocol !== "https:" &&
              !(u.protocol === "http:" && loopback)) ||
            u.username ||
            u.password ||
            u.hash
          )
            throw new InvalidClientMetadataError(
              "Redirect URIs must use HTTPS or HTTP on loopback",
            );
        }
        if (
          !["none", "client_secret_post"].includes(
            client.token_endpoint_auth_method ?? "client_secret_post",
          )
        )
          throw new InvalidClientMetadataError(
            "Unsupported client authentication",
          );
        const value = {
          ...client,
          client_id: client.client_id ?? randomUUID(),
          client_id_issued_at: client.client_id_issued_at ?? now(),
        };
        store.set("client", value.client_id, value);
        return value;
      },
    },
    async authorize(client, params, res) {
      if (!resourceOk(params.resource))
        throw new InvalidTargetError("Wrong resource");
      if (params.scopes?.some((x) => !SCOPES.includes(x)))
        throw new InvalidScopeError("Unsupported scope");
      const id = random(),
        csrf = random();
      const pending = {
        clientId: client.client_id,
        params: {
          ...params,
          resource: RESOURCE,
          scopes: params.scopes?.length ? params.scopes : SCOPES,
        },
        csrf: digest(csrf),
      };
      store.clean();
      store.set("pending", id, pending, now() + 600);
      res.cookie("__Host-wa-mcp-oauth", csrf, {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 600000,
      });
      consentPage(res, id, client, pending);
    },
    async challengeForAuthorizationCode(client, code) {
      const r = store.get("code", digest(code));
      if (!r || r.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid authorization code");
      return r.challenge;
    },
    async exchangeAuthorizationCode(
      client,
      code,
      _verifier,
      redirectUri,
      resource,
    ) {
      if (!resourceOk(resource)) throw new InvalidTargetError("Wrong resource");
      const pendingCode = store.get("code", digest(code));
      if (!pendingCode || !(await resolvePrincipal(pendingCode.principal)))
        throw new InvalidGrantError("Credential revoked or expired");
      return store.transaction(() => {
        const r = store.get("code", digest(code));
        if (
          !r ||
          r.clientId !== client.client_id ||
          r.redirectUri !== redirectUri
        )
          throw new InvalidGrantError("Invalid authorization code or redirect");
        store.delete("code", digest(code));
        const grantId = randomUUID(),
          grant = {
            clientId: client.client_id,
            principal: r.principal,
            scopes: r.scopes,
            resource: RESOURCE,
            expires: now() + 30 * 86400,
            revoked: false,
          };
        store.set("grant", grantId, grant, grant.expires);
        return issue(grantId, grant);
      });
    },
    async exchangeRefreshToken(client, token, scopes, resource) {
      if (!resourceOk(resource)) throw new InvalidTargetError("Wrong resource");
      const current = getGrant("refresh", token, client);
      if (!(await resolvePrincipal(current.grant.principal)))
        throw new InvalidGrantError("Credential revoked or expired");
      return store.transaction(() => {
        const { record, grant } = getGrant("refresh", token, client);
        if (scopes?.some((s) => !grant.scopes.includes(s)))
          throw new InvalidScopeError("Cannot expand scopes");
        if (scopes?.length) grant.scopes = scopes;
        store.delete("refresh", digest(token));
        store.set("grant", record.grantId, grant, grant.expires);
        return issue(record.grantId, grant);
      });
    },
    async verifyAccessToken(token) {
      try {
        const { record, grant } = getGrant("access", token);
        const auth = await resolvePrincipal(grant.principal);
        if (!auth)
          throw new InvalidTokenError(
            "Account credential changed or was removed",
          );
        return {
          principal: auth,
          scopes: grant.scopes,
          resource: RESOURCE,
          clientId: record.clientId,
        };
      } catch {
        throw new InvalidTokenError("Invalid or expired access token");
      }
    },
    async revokeToken(client, request) {
      try {
        const kind =
          request.token_type_hint === "refresh_token" ? "refresh" : "access";
        let r = store.get(kind, digest(request.token));
        if (!r)
          r = store.get(
            kind === "access" ? "refresh" : "access",
            digest(request.token),
          );
        if (r?.clientId === client.client_id) {
          const grant = store.get("grant", r.grantId);
          if (grant) {
            grant.revoked = true;
            store.set("grant", r.grantId, grant, grant.expires);
          }
        }
      } catch {}
    },
  };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.use("/authorize", (_req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = (status, url) => {
      if (typeof status !== "number") {
        url = status;
        status = 302;
      }
      const target = new URL(url, ORIGIN);
      target.searchParams.set("iss", issuer.href);
      return redirect(status, target.href);
    };
    next();
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      ...createOAuthMetadata({
        provider,
        issuerUrl: issuer,
        scopesSupported: SCOPES,
      }),
      authorization_response_iss_parameter_supported: true,
    }),
  );
  app.get("/.well-known/oauth-protected-resource", (_req, res) =>
    res.redirect("/.well-known/oauth-protected-resource/mcp"),
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: new URL(RESOURCE),
      scopesSupported: SCOPES,
      resourceName: "WhatsApp MCP",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  const attempts = new Map();
  app.post(
    "/oauth/consent",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      res.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      if (req.headers.origin !== ORIGIN)
        return res.status(403).send("Invalid origin");
      const ip = req.ip,
        key = String(req.body.key ?? ""),
        id = String(req.body.request ?? "");
      const pending = store.get("pending", id);
      const cookie = String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("__Host-wa-mcp-oauth="))
        ?.split("=")
        .slice(1)
        .join("=");
      if (!pending || !cookie || digest(cookie) !== pending.csrf)
        return res
          .status(400)
          .send("Request expired. Start the connection again from your agent.");
      const client = store.get("client", pending.clientId);
      if (!client) return res.status(400).send("Client is not registered.");
      const count = attempts.get(ip);
      if (count && count.until > Date.now() && count.count >= 10)
        return res.status(429).send("Too many attempts. Wait 15 minutes.");
      let principal;
      try {
        principal = await identify(key);
      } catch {}
      if (!principal) {
        const c =
          count && count.until > Date.now()
            ? count
            : { count: 0, until: Date.now() + 900000 };
        c.count++;
        attempts.set(ip, c);
        return consentPage(
          res.status(401),
          id,
          client,
          pending,
          "Invalid access key.",
        );
      }
      if (principal.role === "owner") principal = authForOwner();
      let scopes = pending.params.scopes.filter(
        (s) =>
          s === "whatsapp:read" ||
          (s === "whatsapp:send" && req.body.send === "yes") ||
          (s === "whatsapp:manage" && req.body.manage === "yes"),
      );
      scopes = scopes.filter((s) =>
        principal.permissions.includes(s.split(":")[1]),
      );
      if (!scopes.includes("whatsapp:read")) scopes.unshift("whatsapp:read");
      const code = random();
      store.transaction(() => {
        store.set(
          "code",
          digest(code),
          {
            clientId: client.client_id,
            principal,
            scopes,
            challenge: pending.params.codeChallenge,
            redirectUri: pending.params.redirectUri,
          },
          now() + 120,
        );
        store.delete("pending", id);
      });
      res.set(
        "Content-Security-Policy",
        `default-src 'none'; form-action 'self' ${new URL(pending.params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      );
      res.clearCookie("__Host-wa-mcp-oauth", {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
      const redirect = new URL(pending.params.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", issuer.href);
      if (pending.params.state)
        redirect.searchParams.set("state", pending.params.state);
      res.redirect(303, redirect.href);
    },
  );
  return { app, provider, store, challenge, resource: RESOURCE };
}

function consentPage(res, id, client, pending, error = "") {
  const callbackOrigin = new URL(pending.params.redirectUri).origin;
  res.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
  const send = pending.params.scopes.includes("whatsapp:send");
  const manage = pending.params.scopes.includes("whatsapp:manage");
  res
    .type("html")
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect WhatsApp</title><style>body{font:16px system-ui;background:#f2f4f3;color:#172a22;margin:0;padding:32px}main{max-width:480px;margin:8vh auto;background:white;padding:32px;border-radius:16px}h1{font-size:26px}label{display:block;margin:20px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #7a8d83;border-radius:7px}button{margin-top:24px;width:100%;padding:13px;background:#126341;color:white;border:0;border-radius:7px;font:inherit}small{color:#53655c}.error{color:#a00}</style><main><h1>Connect WhatsApp to your agent</h1><p>Authorize <strong>${escape(client.client_name ?? "Cliente MCP")}</strong>.</p><p><small>Callback: ${escape(new URL(pending.params.redirectUri).origin)}</small></p><p>An owner access key connects all accounts. An account access key connects only its own account.</p>${error ? `<p class="error">${escape(error)}</p>` : ""}<form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${escape(id)}"><label for="key">Access key</label><input id="key" type="password" name="key" required autocomplete="off"><label><input type="checkbox" checked disabled> Read accounts, chats, contacts and groups</label>${send ? '<label><input type="checkbox" name="send" value="yes" checked> Allow sending messages</label>' : ""}${manage ? '<label><input type="checkbox" name="manage" value="yes" checked> Allow pairing and account management</label>' : ""}<button type="submit">Authorize connection</button></form><p><small>Your access key remains on this server. The agent receives a revocable authorization.</small></p></main></html>`,
    );
}
