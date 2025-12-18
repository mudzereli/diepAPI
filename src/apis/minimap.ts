import { CanvasKit } from '../core/canvas_kit';
import { Vector } from '../core/vector';
import { game } from './game';

/**
 * The Minimap API
 */
class Minimap {
  #minimapDim = new Vector(1, 1);
  #minimapPos = new Vector(0, 0);

  #viewportDim = new Vector(1, 1);
  #viewportPos = new Vector(1, 1);

  #arrowPos = new Vector(0.5, 0.5);

  #drawViewport = false;

  constructor() {
    game.once('ready', () => {
      if (_window.input == null) {
        throw new Error('diepAPI: window.input does not exist.');
      }

      _window.input.set_convar('ren_minimap_viewport', 'true');
      _window.input.set_convar = new Proxy(_window.input.set_convar, {
        apply: (target, thisArg, args) => {
          if (args[0] === 'ren_minimap_viewport') {
            this.#drawViewport = args[1] as boolean;
            return;
          }

          return Reflect.apply(target, thisArg, args);
        },
      });
    });

    this.#minimapHook();
    this.#viewportHook();
    this.#arrowHook();
  }

  get minimapDim(): Vector {
    return this.#minimapDim;
  }

  get minimapPos(): Vector {
    return this.#minimapPos;
  }

  get viewportDim(): Vector {
    return this.#viewportDim;
  }

  get viewportPos(): Vector {
    return this.#viewportPos;
  }

  get arrowPos(): Vector {
    return this.#arrowPos;
  }

  #minimapHook() {
    CanvasKit.hookCtx('strokeRect', (target, thisArg, args) => {
      const transform = thisArg.getTransform();

      this.#minimapDim = new Vector(transform.a, transform.d);
      this.#minimapPos = new Vector(transform.e, transform.f);
    });
  }

  #viewportHook() {
    CanvasKit.overrideCtx('fillRect', (target, thisArg, args) => {
      const transform = thisArg.getTransform();

      // 1) Alpha range (not equality)
      const a = thisArg.globalAlpha;
      if (a < 0.05 || a > 0.2) {
        return Reflect.apply(target, thisArg, args);
      }

      // 2) Aspect ratio (looser tolerance)
      const arWin = _window.innerWidth / _window.innerHeight;
      const arRect = transform.a / transform.d;

      if (Math.abs(arRect - arWin) > arWin * 0.002) {
        return Reflect.apply(target, thisArg, args);
      }

      // ACCEPTED
      this.#viewportDim = new Vector(transform.a, transform.d);
      this.#viewportPos = new Vector(transform.e, transform.f);

      if (this.#drawViewport) {
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  #arrowHook() {
    CanvasKit.hookPolygon(3, (vertices) => {
      const centroid = Vector.centroid(...vertices);

      // Reject triangles not inside minimap bounds
      if (
        centroid.x < this.#minimapPos.x ||
        centroid.y < this.#minimapPos.y ||
        centroid.x > this.#minimapPos.x + this.#minimapDim.x ||
        centroid.y > this.#minimapPos.y + this.#minimapDim.y
      ) return;

      const rel = Vector.subtract(centroid, this.#minimapPos);
      this.#arrowPos = Vector.divide(rel, this.#minimapDim);
    });
  }
}

export const minimap = new Minimap();
