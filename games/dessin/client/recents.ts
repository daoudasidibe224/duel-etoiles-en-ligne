import { roomName } from "../shared/contracts";
function key(id: string) {
  return "draw-recent-" + id;
}
export function recentRooms(id: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key(id)) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .flatMap((value) => {
        const parsed = roomName.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}
export function rememberRoom(id: string, name: string): boolean {
  try {
    localStorage.setItem(
      key(id),
      JSON.stringify(
        [name, ...recentRooms(id).filter((value) => value !== name)].slice(
          0,
          5,
        ),
      ),
    );
    return true;
  } catch {
    return false;
  }
}
export function forgetRooms(id: string) {
  localStorage.removeItem(key(id));
}
