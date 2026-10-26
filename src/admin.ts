export const adminHtml = `
<!doctype html>
<html lang="en">
  <meta charset="utf-8" /><meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  /><title>WhatsApp MCP</title
  ><link rel="stylesheet" href="/admin.css" />
  <main>
    <header>
      <h1>WhatsApp MCP</h1>
      <p>Connect accounts. Let your agents do the rest.</p>
    </header>
    <form id="login">
      <label
        >Access key<input
          id="access-key"
          type="password"
          autocomplete="off"
          required /></label
      ><button>Connect</button>
    </form>
    <section id="workspace" hidden>
      <form id="create">
        <label
          >New account name<input
            id="account-name"
            maxlength="64"
            required /></label
        ><button>Create account</button>
      </form>
      <div id="accounts"></div>
      <section id="pairing" hidden>
        <h2 id="pairing-title"></h2>
        <p id="pairing-state"></p>
        <img id="qr" alt="WhatsApp pairing QR" hidden />
        <p>On your phone: WhatsApp → Linked devices → Link a device.</p>
        <button id="close-pairing">Close</button>
      </section>
    </section>
    <p id="notice" role="status"></p>
    <footer>Self-hosted · Standard MCP · <a href="/health">Health</a></footer>
  </main>
  <script src="/admin.js" defer></script>
</html>
`;
export const adminCss = `
:root {
  color-scheme: light dark;
  font: 16px system-ui;
}
body {
  margin: 0;
  background: #10201c;
  color: #e5eee9;
}
main {
  max-width: 780px;
  margin: 6vh auto;
  padding: 24px;
}
h1 {
  font-size: 36px;
  margin-bottom: 6px;
}
header p,
footer {
  color: #afc2b8;
}
form,
.account,
#pairing {
  background: #1b3029;
  padding: 20px;
  margin: 18px 0;
  border-radius: 12px;
}
label {
  display: block;
}
input {
  box-sizing: border-box;
  display: block;
  width: 100%;
  padding: 12px;
  margin: 8px 0 14px;
  font: inherit;
  border: 1px solid #6b8e7c;
  border-radius: 6px;
}
button {
  background: #c4f3ce;
  color: #0e2920;
  border: 0;
  padding: 10px 16px;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
  margin: 4px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.account h2 {
  font-size: 20px;
  margin: 0 0 6px;
}
.account p {
  color: #afc2b8;
}
#qr {
  display: block;
  width: 300px;
  max-width: 100%;
  background: white;
  padding: 10px;
}
#qr[hidden] {
  display: none;
}
#notice {
  white-space: pre-wrap;
}
a {
  color: #c4f3ce;
}
[hidden] {
  display: none !important;
}
`;
export const adminJs = `
(() => {
  let key = "",
    allowed = new Set(),
    selected = null,
    timer = null,
    sequence = 0,
    expiry = 0,
    controller = null;
  const el = (id) => document.getElementById(id),
    notice = (text) => (el("notice").textContent = text);
  async function call(name, args = {}) {
    const r = await fetch("/api/tools/call", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!r.ok)
      throw new Error(
        "Access denied or service unavailable (" + r.status + ")",
      );
    const value = await r.json();
    if (value.isError) throw new Error(value.content[0].text);
    return value;
  }
  function data(value) {
    return JSON.parse(value.content.find((c) => c.type === "text").text);
  }
  async function refresh() {
    const rows = data(await call("whatsapp_account_list")).accounts;
    el("accounts").replaceChildren();
    for (const a of rows) {
      const row = document.createElement("article");
      row.className = "account";
      const title = document.createElement("h2");
      title.textContent = a.name;
      const state = document.createElement("p");
      state.textContent = [
        a.state,
        a.selfJid || "Not paired",
        "History: " + a.syncStatus,
      ].join(" · ");
      row.append(title, state);
      if (allowed.has("whatsapp_pairing_start")) {
        const pair = document.createElement("button");
        pair.textContent = a.state === "open" ? "Connection" : "Pair with QR";
        pair.onclick = () => pairAccount(a);
        row.append(pair);
      }
      if (allowed.has("whatsapp_account_disconnect")) {
        const pause = document.createElement("button");
        pause.textContent = "Pause";
        pause.onclick = async () => {
          try {
            if (selected?.id === a.id) stopPair();
            await call("whatsapp_account_disconnect", { account: a.id });
            await refresh();
          } catch (e) {
            notice(e.message);
          }
        };
        row.append(pause);
      }
      el("accounts").append(row);
    }
  }
  function stopPair() {
    sequence++;
    if (timer) clearInterval(timer);
    controller?.abort();
    selected = null;
    el("pairing").hidden = true;
    el("qr").hidden = true;
    el("qr").removeAttribute("src");
  }
  async function pairAccount(account) {
    stopPair();
    selected = account;
    el("pairing").hidden = false;
    el("pairing-title").textContent = account.name;
    notice("");
    try {
      await call("whatsapp_pairing_start", { account: account.id });
      await refresh();
      timer = setInterval(() => {
        if (expiry && Date.now() >= expiry) {
          el("qr").hidden = true;
          el("qr").removeAttribute("src");
        }
        void poll();
      }, 2000);
      await poll();
    } catch (e) {
      notice(e.message);
    }
  }
  async function poll() {
    if (!selected) return;
    const local = selected,
      seq = ++sequence;
    controller?.abort();
    controller = new AbortController();
    try {
      const r = await fetch("/api/tools/call", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "whatsapp_pairing_get",
          arguments: { account: local.id },
        }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error("QR request failed");
      const result = await r.json();
      if (result.isError) throw new Error(result.content[0].text);
      const d = data(result);
      if (seq !== sequence || selected?.id !== local.id) return;
      const image = result.content.find((c) => c.type === "image");
      if (image && d.expiresAt > Date.now()) {
        expiry = d.expiresAt;
        el("qr").src = "data:image/png;base64," + image.data;
        el("qr").hidden = false;
        el("pairing-state").textContent =
          "Scan this QR. It refreshes automatically.";
      } else {
        el("qr").hidden = true;
        el("qr").removeAttribute("src");
        el("pairing-state").textContent = d.state || "Waiting for a fresh QR";
        if (d.state === "open") {
          clearInterval(timer);
          await refresh();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError" && seq === sequence) notice(e.message);
    }
  }
  el("login").onsubmit = async (e) => {
    e.preventDefault();
    key = el("access-key").value;
    try {
      const r = await fetch("/api/tools/list", {
        headers: { Authorization: "Bearer " + key },
      });
      if (!r.ok) throw new Error("Invalid access key");
      allowed = new Set((await r.json()).tools);
      await refresh();
      el("workspace").hidden = false;
      el("login").hidden = true;
      el("access-key").value = "";
      el("create").hidden = !allowed.has("whatsapp_account_create");
      notice("");
    } catch (e) {
      key = "";
      notice(e.message);
    }
  };
  el("create").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call("whatsapp_account_create", { name: el("account-name").value });
      el("account-name").value = "";
      await refresh();
    } catch (e) {
      notice(e.message);
    }
  };
  el("close-pairing").onclick = stopPair;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && selected) void poll();
  });
})();
`;
