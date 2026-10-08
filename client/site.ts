document
  .querySelectorAll<HTMLButtonElement>(".navbar-burger")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.classList.toggle("is-active", !expanded);
      if (button.dataset.target)
        document
          .getElementById(button.dataset.target)
          ?.classList.toggle("is-active", !expanded);
    });
  });
