export function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Élément manquant : ${id}`);
  return node;
}
export function canvasElement(id: string): HTMLCanvasElement {
  const node = element(id);
  if (!(node instanceof HTMLCanvasElement))
    throw new Error("Canvas introuvable");
  return node;
}
export function inputElement(id: string): HTMLInputElement {
  const node = element(id);
  if (!(node instanceof HTMLInputElement)) throw new Error("Champ introuvable");
  return node;
}

export function accessEnded(message: string) {
  const alert = element("access-ended");
  const text = element("access-ended-message");
  text.textContent = message;
  alert.classList.remove("cacher");
  alert.focus();
  window.dispatchEvent(new Event("session-ended"));
}
