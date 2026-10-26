import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createOAuth } from "../dist/oauth.mjs";
import { fixture } from "./helpers.mjs";
test("OAuth discovery, PKCE, CSRF, scope reduction, persistence, refresh and credential revocation", async (t) => {
  const f = fixture(t),
    origin = "https://whatsapp.example.test",
    resource = origin + "/mcp",
    a = f.store.createAccount("Private account"),
    key = f.access.issue(a.id, ["read", "send"]);
  const settings = {
    config: {
      ...f.config,
      publicUrl: origin,
      ownerProfileId: f.access.ownerProfileId,
    },
    adminToken: f.config.adminToken,
    storePath: join(f.dir, "oauth.sqlite"),
    identify: async (k) => f.access.identify(k),
    resolvePrincipal: async (p) => f.access.resolve(p),
  };
  const o = createOAuth(settings),
    http = createServer(o.app);
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + http.address().port;
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
    o.store.db.close();
  });
  const form = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const register = (uri) =>
    fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Any MCP agent",
        redirect_uris: [uri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
  const md = await (
    await fetch(base + "/.well-known/oauth-authorization-server")
  ).json();
  assert(md.code_challenge_methods_supported.includes("S256"));
  assert(md.authorization_response_iss_parameter_supported);
  const prm = await (
    await fetch(base + "/.well-known/oauth-protected-resource/mcp")
  ).json();
  assert.equal(prm.resource, resource);
  assert.equal((await register("http://evil.invalid/callback")).status, 400);
  assert.equal((await register("http://127.0.0.1:9911/callback")).status, 201);
  const client = await (
      await register("https://agent.example.test/callback")
    ).json(),
    verifier = "a".repeat(64),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  assert(client.client_id);
  async function authorize(accessKey, send = false) {
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      scope: "whatsapp:read whatsapp:send whatsapp:manage",
      state: "preserved",
    });
    const res = await fetch(base + "/authorize?" + params, {
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert(
      res.headers
        .get("content-security-policy")
        .includes("form-action 'self' https://agent.example.test"),
    );
    const html = await res.text(),
      id = html.match(/name="request" value="([^"]+)"/)[1],
      cookie = res.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await form(
          "/oauth/consent",
          { request: id, key: accessKey },
          { origin },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await form(
          "/oauth/consent",
          { request: id, key: accessKey },
          { origin: "https://evil.invalid", cookie },
        )
      ).status,
      403,
    );
    const approval = await form(
      "/oauth/consent",
      {
        request: id,
        key: accessKey,
        ...(send ? { send: "yes", manage: "yes" } : {}),
      },
      { origin, cookie },
    );
    assert.equal(approval.status, 303);
    const redirect = new URL(approval.headers.get("location"));
    assert.equal(redirect.searchParams.get("iss"), md.issuer);
    assert.equal(redirect.searchParams.get("state"), "preserved");
    return redirect.searchParams.get("code");
  }
  const code = await authorize(key.token),
    exchange = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: client.redirect_uris[0],
      resource,
    };
  assert.equal(
    (await form("/token", { ...exchange, code_verifier: "wrong" })).status,
    400,
  );
  assert.equal(
    (
      await form("/token", {
        ...exchange,
        resource: "https://evil.invalid/mcp",
      })
    ).status,
    400,
  );
  const tokens = await (await form("/token", exchange)).json();
  assert(tokens.access_token && tokens.refresh_token);
  assert.equal((await form("/token", exchange)).status, 400);
  const auth = await o.provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(auth.scopes, ["whatsapp:read"]);
  assert.equal(auth.principal.accountId, a.id);
  const reopened = createOAuth(settings);
  assert.equal(
    (await reopened.provider.verifyAccessToken(tokens.access_token)).principal
      .profileId,
    a.profileId,
  );
  reopened.store.db.close();
  const refresh = {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  };
  assert.equal(
    (await form("/token", { ...refresh, scope: "whatsapp:manage" })).status,
    400,
  );
  const rotated = await (await form("/token", refresh)).json();
  assert(rotated.access_token);
  assert.equal((await form("/token", refresh)).status, 400);
  f.access.revoke(key.id);
  await assert.rejects(() =>
    o.provider.verifyAccessToken(rotated.access_token),
  );
  assert.equal(
    (await form("/token", { ...refresh, refresh_token: rotated.refresh_token }))
      .status,
    400,
  );
  const ownerCode = await authorize(f.config.adminToken, true),
    owner = await (
      await form("/token", { ...exchange, code: ownerCode })
    ).json();
  assert.deepEqual(
    (await o.provider.verifyAccessToken(owner.access_token)).scopes,
    ["whatsapp:read", "whatsapp:send", "whatsapp:manage"],
  );
  assert.equal(
    (
      await form("/revoke", {
        client_id: client.client_id,
        token: owner.refresh_token,
        token_type_hint: "refresh_token",
      })
    ).status,
    200,
  );
  await assert.rejects(() => o.provider.verifyAccessToken(owner.access_token));
});
