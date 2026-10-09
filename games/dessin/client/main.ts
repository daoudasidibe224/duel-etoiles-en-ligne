import { session, watchIdentity, accessLink, base } from "./api";
import { element, showError, errorMessage } from "./dom";
import { mountLobby } from "./lobby";
import { mountGame } from "./game";
async function main() {
  const loading = element("initial-loading", HTMLElement);
  const retry = element("initial-retry", HTMLButtonElement);
  retry.addEventListener("click", () => location.reload());
  try {
    const data = await session();
    const view = !data.user
      ? "guest"
      : location.pathname === base + "/room"
        ? "game"
        : "lobby";
    element(view, HTMLElement).hidden = false;
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "a[data-access]",
    ))
      link.href = accessLink();
    element("access-link", HTMLAnchorElement).hidden = !!data.user;
    element("profile-link", HTMLAnchorElement).hidden = data.kind !== "account";
    const identity = element("nav-identity", HTMLElement);
    identity.hidden = !data.user;
    identity.textContent = data.user
      ? data.user.name + (data.kind === "guest" ? " · invité" : "")
      : "";
    const logout = element("logout-form", HTMLFormElement);
    if (data.user && data.logout) {
      logout.action = data.logout.action;
      element("logout-csrf", HTMLInputElement).value = data.logout.csrf;
      logout.hidden = false;
      element("logout", HTMLButtonElement).textContent =
        data.kind === "guest" ? "Quitter l’accès invité" : "Se déconnecter";
    }
    if (view === "lobby" && data.user) await mountLobby(data.user);
    if (view === "game" && data.user) mountGame(data.user);
    let checking = false;
    watchIdentity(() => {
      if (checking) return;
      checking = true;
      void session()
        .then((latest) => {
          if (latest.user?.id !== data.user?.id || latest.kind !== data.kind) {
            location.replace(base + "/lobby");
            return;
          }
          if (latest.user && data.user) {
            data.user.name = latest.user.name;
            identity.textContent =
              latest.user.name + (latest.kind === "guest" ? " · invité" : "");
          }
        })
        .catch(() => {
          /* Une coupure réseau conserve la page et la saisie. */
        })
        .finally(() => {
          checking = false;
        });
    });
  } catch (error) {
    showError("global-error", errorMessage(error));
    retry.hidden = false;
  } finally {
    loading.hidden = true;
  }
}
void main();
