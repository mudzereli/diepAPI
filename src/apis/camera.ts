import { Vector } from '../core/vector';
import { arena } from './arena';
import { game } from './game';
import { minimap } from './minimap';

class Camera {
  #position: Vector = new Vector(0, 0);

  // 🔍 debug fields
  #center: Vector = new Vector(0, 0);
  #cameraPos: Vector = new Vector(0, 0);
  #normalized: Vector = new Vector(0, 0);

  constructor() {
    game.on('frame_end', () => {
      const center = Vector.add(
        minimap.viewportPos,
        Vector.unscale(2, minimap.viewportDim)
      );

      const cameraPos = Vector.subtract(center, minimap.minimapPos);
      const normalized = Vector.divide(cameraPos, minimap.minimapDim);

      this.#center = center;
      this.#cameraPos = cameraPos;
      this.#normalized = normalized;
      this.#position = arena.scale(normalized);
    });
  }

  // existing
  get position(): Vector {
    return this.#position;
  }

  // 🔍 debug getters
  get debug() {
    return {
      center: this.#center,
      cameraPos: this.#cameraPos,
      normalized: this.#normalized,
      position: this.#position,
    };
  }
}

export const camera = new Camera();
