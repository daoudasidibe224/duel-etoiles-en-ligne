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
