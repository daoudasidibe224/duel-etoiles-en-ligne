export function element<T extends HTMLElement>(
  id: string,
  constructor: { new (...args: never[]): T },
): T {
  const item = document.getElementById(id);
  if (!(item instanceof constructor)) throw new Error("Élément absent : " + id);
  return item;
}
export function showError(id: string, message: string) {
  const item = element(id, HTMLElement);
  item.textContent = message;
  item.hidden = !message;
}
export function field(form: HTMLFormElement, name: string) {
  const item = form.elements.namedItem(name);
  if (!(item instanceof HTMLInputElement || item instanceof HTMLSelectElement))
    throw new Error("Champ absent.");
  return item.value;
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "La connexion a échoué. Réessayez.";
}
