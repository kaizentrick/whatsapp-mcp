import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { Store, hash } from "./store.js";

export type Permission = "read" | "send" | "manage";
export type Principal = {
  role: "owner" | "account";
  profileId: string;
  name: string;
  permissions: Permission[];
  accountId?: string;
  epoch?: number;
  tokenHash?: string;
  credentialHash?: string;
};
export const equalSecret = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class Access {
  readonly ownerProfileId: string;
  constructor(
    readonly store: Store,
    private config: Config,
  ) {
    this.ownerProfileId =
      store.get<string>("meta", "", "owner-profile") ?? randomUUID();
    store.put("meta", "", "owner-profile", this.ownerProfileId);
  }
  owner(): Principal {
    return {
      role: "owner",
      profileId: this.ownerProfileId,
      name: "All WhatsApp accounts",
      permissions: ["read", "send", "manage"],
      credentialHash: hash(this.config.adminToken),
    };
  }
  issue(
    accountId: string,
    permissions: Permission[],
    days = 30,
  ): { token: string; id: string; expiresAt: number } {
    const account = this.store.account(accountId);
    if (
      !permissions.includes("read") ||
      permissions.some((p) => !["read", "send", "manage"].includes(p))
    )
      throw new Error(
        "Permissions must include read and use only read,send,manage",
      );
    if (!Number.isInteger(days) || days < 1 || days > 365)
      throw new Error("Token lifetime must be 1-365 days");
    const token = "wa_" + randomBytes(32).toString("base64url"),
      id = hash(token),
      expiresAt = Date.now() + days * 86400000;
    this.store.put(
      "access-key",
      "",
      id,
      { accountId: account.id, epoch: account.epoch, permissions },
      expiresAt,
    );
    return { token, id, expiresAt };
  }
  identify(token: string): Principal | null {
    if (equalSecret(token, this.config.adminToken)) return this.owner();
    const id = hash(token),
      record = this.store.get<any>("access-key", "", id);
    if (!record) return null;
    try {
      const account = this.store.account(record.accountId);
      if (account.epoch !== record.epoch) return null;
      return {
        role: "account",
        profileId: account.profileId,
        name: account.label ?? account.name,
        accountId: account.id,
        epoch: account.epoch,
        permissions: record.permissions,
        tokenHash: id,
      };
    } catch {
      return null;
    }
  }
  resolve(principal: Principal): Principal | null {
    if (principal.role === "owner")
      return principal.credentialHash === hash(this.config.adminToken)
        ? this.owner()
        : null;
    if (!principal.tokenHash) return null;
    const record = this.store.get<any>("access-key", "", principal.tokenHash);
    if (!record) return null;
    try {
      const account = this.store.account(record.accountId);
      if (account.epoch !== record.epoch || account.id !== principal.accountId)
        return null;
      return {
        ...principal,
        profileId: account.profileId,
        name: account.label ?? account.name,
        permissions: record.permissions,
      };
    } catch {
      return null;
    }
  }
  revoke(id: string): void {
    this.store.remove("access-key", "", id);
  }
}
