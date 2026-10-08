for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".navbar-burger",
)) {
  const navigation = button.dataset.target
    ? document.getElementById(button.dataset.target)
    : null;
  function setOpen(open: boolean) {
    button.setAttribute("aria-expanded", String(open));
    button.classList.toggle("is-active", open);
    navigation?.classList.toggle("is-active", open);
  }
  button.addEventListener("click", () =>
    setOpen(button.getAttribute("aria-expanded") !== "true"),
  );
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      button.getAttribute("aria-expanded") === "true"
    ) {
      setOpen(false);
      button.focus();
    }
  });
}

for (const toggle of document.querySelectorAll<HTMLButtonElement>(
  "[data-password-toggle]",
)) {
  const field = document.getElementById(toggle.dataset.passwordToggle || "");
  if (!(field instanceof HTMLInputElement)) continue;
  toggle.addEventListener("click", () => {
    const visible = field.type === "password";
    field.type = visible ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.textContent = visible
      ? "Masquer le mot de passe"
      : "Afficher le mot de passe";
  });
}
document.querySelector<HTMLElement>("[data-error-summary]")?.focus();

const ENTRY_PATH = "/jouer",
  HOME_PATH = "/salon";
// La session du serveur reste la référence, y compris entre onglets.
const sessionMeta = document.querySelector<HTMLMetaElement>(
  'meta[name="session-key"]',
);
const identityMeta = document.querySelector<HTMLMetaElement>(
  'meta[name="identity-key"]',
);
const expectedSession = sessionMeta?.content ?? "visitor";
const expectedIdentity = identityMeta?.content ?? "visitor";
let checking = false,
  navigating = false,
  recheckPending = false,
  dirty = false,
  transportVerification = false;
document.addEventListener("input", () => {
  dirty = true;
});
const channel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("session-state")
    : undefined;
function connectionNotice(message: string | undefined) {
  const banner = document.getElementById("access-ended"),
    text = document.getElementById("access-ended-message");
  if (!banner || !text) return;
  banner.hidden = !message;
  text.textContent = message ?? "";
}
async function checkSession() {
  if (navigating) return;
  if (checking) {
    recheckPending = true;
    return;
  }
  checking = true;
  try {
    const response = await fetch("/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      connectionNotice(
        "Le serveur est momentanément indisponible. Votre saisie reste dans cet onglet.",
      );
      return;
    }
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      typeof value.key !== "string" ||
      !("identity" in value) ||
      typeof value.identity !== "string"
    )
      return;
    if (value.key === expectedSession) {
      connectionNotice(undefined);
      if (transportVerification) {
        transportVerification = false;
        window.dispatchEvent(new Event("session-verified"));
      }
      return;
    }
    navigating = true;
    if (dirty && expectedIdentity !== "visitor") {
      const fields: Record<string, { value: string; checked?: boolean }> = {};
      for (const field of document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("main input, main textarea, main select")) {
        if (
          !field.name ||
          field.name === "_csrf" ||
          (field instanceof HTMLInputElement &&
            ["password", "hidden", "file"].includes(field.type))
        )
          continue;
        fields[field.name] = {
          value: field.value,
          ...(field instanceof HTMLInputElement &&
          ["checkbox", "radio"].includes(field.type)
            ? { checked: field.checked }
            : {}),
        };
      }
      sessionStorage.setItem(
        `draft:${expectedIdentity}:${location.pathname}`,
        JSON.stringify(fields),
      );
    }
    // Ne pas laisser des données du compte précédent affichées pendant le changement.
    document.querySelector("main")?.replaceChildren();
    sessionStorage.setItem(
      "session-refresh",
      dirty
        ? "La session a changé. Votre brouillon est conservé dans cet onglet pour votre compte."
        : value.identity === "visitor"
          ? "Votre session est terminée. Vous pouvez reprendre quand vous voulez."
          : "Votre accès a été mis à jour.",
    );
    channel?.postMessage("changed");
    location.replace(value.identity === "visitor" ? ENTRY_PATH : HOME_PATH);
  } catch {
    connectionNotice(
      "La connexion au serveur est interrompue. Votre saisie reste dans cet onglet.",
    );
  } finally {
    checking = false;
    if (recheckPending && !navigating) {
      recheckPending = false;
      void checkSession();
    }
  }
}
channel?.addEventListener("message", () => {
  void checkSession();
});
window.addEventListener("focus", () => {
  void checkSession();
});
window.addEventListener("pageshow", () => {
  void checkSession();
  channel?.postMessage("changed");
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void checkSession();
});
window.addEventListener("session-ended", () => {
  transportVerification = true;
  void checkSession();
});
let interval: number | undefined;
function startPolling() {
  if (interval !== undefined) return;
  interval = window.setInterval(() => {
    if (!document.hidden) void checkSession();
  }, 5000);
}
startPolling();
window.addEventListener("pageshow", startPolling);
window.addEventListener("pagehide", () => {
  clearInterval(interval);
  interval = undefined;
});
const deadline = Number(
  document.querySelector<HTMLMetaElement>('meta[name="session-expires"]')
    ?.content,
);
if (deadline > Date.now())
  window.setTimeout(
    () => {
      void checkSession();
    },
    Math.min(deadline - Date.now() + 30, 2147483647),
  );
const notice = sessionStorage.getItem("session-refresh");
if (notice) {
  sessionStorage.removeItem("session-refresh");
  const alert = document.createElement("p");
  alert.className = "session-notice";
  alert.setAttribute("role", "status");
  alert.tabIndex = -1;
  alert.textContent = notice;
  document.querySelector("main")?.prepend(alert);
  alert.focus();
}
const draftKey = `draft:${expectedIdentity}:${location.pathname}`;
const draft = sessionStorage.getItem(draftKey);
if (draft && expectedIdentity !== "visitor") {
  try {
    const fields: unknown = JSON.parse(draft);
    if (fields && typeof fields === "object")
      for (const field of document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >("main input, main textarea, main select")) {
        if (field.name in fields) {
          const value: unknown = Reflect.get(fields, field.name);
          if (
            value &&
            typeof value === "object" &&
            "value" in value &&
            typeof value.value === "string"
          ) {
            field.value = value.value;
            if (
              field instanceof HTMLInputElement &&
              "checked" in value &&
              typeof value.checked === "boolean"
            )
              field.checked = value.checked;
            const details = field.closest("details");
            if (details && field.value) details.open = true;
          }
        }
      }
    sessionStorage.removeItem(draftKey);
  } catch {
    sessionStorage.removeItem(draftKey);
  }
}

document.getElementById("session-retry")?.addEventListener("click", () => {
  void checkSession();
});
