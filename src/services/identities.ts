import { randomBytes } from "node:crypto";
import { z } from "zod";
export const guestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  nomUtilisateur: z.string().regex(/^[a-z0-9_-]{3,24}$/i),
  expiresAt: z.number().int().positive(),
});
export type Guest = z.infer<typeof guestSchema>;
export type Identity = {
  id: string;
  nomUtilisateur: string;
  kind: "guest" | "account";
  expiresAt?: number;
};
export class IdentityAuthority {
  private guests = new Map<string, Guest>();
  private revoked = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    readonly guestDurationMs = 8 * 60 * 60 * 1000,
    private onExpired: (id: string, sessionId: string) => void = () => {},
  ) {
    if (!Number.isFinite(guestDurationMs) || guestDurationMs <= 0)
      throw new Error("Durée invitée invalide.");
  }
  resolve(
    sessionId: string | undefined,
    account: Express.User | undefined,
    savedGuest: unknown,
    sessionExpiresAt?: number,
  ): Identity | undefined {
    if (!sessionId || this.revoked.has(sessionId)) return;
    if (account) {
      if (!sessionExpiresAt || sessionExpiresAt <= Date.now()) return;
      return {
        id: account.id,
        nomUtilisateur: account.nomUtilisateur,
        kind: "account",
        expiresAt: sessionExpiresAt,
      };
    }
    const parsed = guestSchema.safeParse(
      this.guests.get(sessionId) ?? savedGuest,
    );
    if (
      !parsed.success ||
      parsed.data.expiresAt <= Date.now() ||
      (sessionExpiresAt !== undefined && sessionExpiresAt <= Date.now())
    )
      return;
    this.remember(sessionId, parsed.data);
    return {
      ...parsed.data,
      expiresAt: Math.min(
        parsed.data.expiresAt,
        sessionExpiresAt ?? parsed.data.expiresAt,
      ),
      kind: "guest",
    };
  }
  enter(sessionId: string, savedGuest: unknown, nomUtilisateur: string): Guest {
    if (this.revoked.has(sessionId))
      throw new Error("Cette session a été fermée. Rechargez la page.");
    const existing = this.resolve(sessionId, undefined, savedGuest);
    if (existing) {
      if (existing.nomUtilisateur !== nomUtilisateur)
        throw new Error(
          "Votre session invitée existe déjà. Quittez-la pour changer de pseudo.",
        );
      const guest = this.guests.get(sessionId);
      if (!guest) throw new Error("Session invitée introuvable.");
      return guest;
    }
    const guest = {
      id: randomBytes(12).toString("hex"),
      nomUtilisateur,
      expiresAt: Date.now() + this.guestDurationMs,
    };
    this.remember(sessionId, guest);
    return guest;
  }
  private remember(sessionId: string, guest: Guest) {
    if (
      this.guests.get(sessionId)?.id === guest.id &&
      this.timers.has(sessionId)
    )
      return;
    clearTimeout(this.timers.get(sessionId));
    this.guests.set(sessionId, guest);
    const timer = setTimeout(
      () => {
        if (this.guests.get(sessionId)?.id !== guest.id) return;
        this.guests.delete(sessionId);
        this.timers.delete(sessionId);
        this.onExpired(guest.id, sessionId);
      },
      Math.max(0, guest.expiresAt - Date.now()),
    );
    timer.unref();
    this.timers.set(sessionId, timer);
  }
  current(sessionId: string | undefined, identity: Identity): boolean {
    if (!sessionId || this.revoked.has(sessionId)) return false;
    if ((identity.expiresAt ?? 0) <= Date.now()) return false;
    if (identity.kind === "account") return true;
    return (
      (identity.expiresAt ?? 0) > Date.now() &&
      this.guests.get(sessionId)?.id === identity.id
    );
  }
  revoke(sessionId: string) {
    this.guests.delete(sessionId);
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
    this.revoked.add(sessionId);
    const timer = setTimeout(
      () => this.revoked.delete(sessionId),
      24 * 60 * 60 * 1000,
    );
    timer.unref();
  }
}
