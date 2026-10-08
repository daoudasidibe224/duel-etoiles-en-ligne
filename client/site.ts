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
