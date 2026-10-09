import { OrthographicCamera } from "three";
export function createArenaCamera() {
  const camera = new OrthographicCamera(-10, 10, 5.625, -5.625, 0.1, 100);
  camera.position.set(0, 7, 20);
  camera.lookAt(0, 4, 0);
  camera.updateMatrixWorld();
  return camera;
}
