import { sessionSchema } from "../shared/contracts";
export const base = "/dessin";
// The shared site owns accounts and guests. This page only reads the
// identity resolved by the server; it never stores credentials or tokens.
export async function session() {
  const response = await fetch(base + "/api/session", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Le serveur ne répond pas.");
  const body: unknown = await response.json();
  return sessionSchema.parse(body);
}
// The shared site accepts this return address after a guest entry.
export function accessLink() {
  return "/jouer?next=" + encodeURIComponent(base + "/lobby");
}
export function watchIdentity(change: () => void) {
  window.addEventListener("focus", change);
  window.addEventListener("pageshow", change);
  // Another tab of the site may log out or change identity at any time.
  window.setInterval(change, 4000);
}
