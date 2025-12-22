import { game, playerMovement, scaling, camera } from '../apis';
import { CanvasKit, Vector } from '../core';
import { Entity, EntityColor, EntityType, TeamColors } from '../types/entity';
import { Extension } from './extension';

const random_id = () => Math.random().toString(36).slice(2, 5);

// --- canonical (old) radii ---
const CANON = {
  DroneBattle: 23,
  DroneBase:   30,
  DroneOver:   45,     // overseer/overlord (your old 40–46 bucket)
  CrasherS:    35,
  CrasherL:    55,
  Triangle:    55,
  Square:      55,
  Pentagon:    75,
  Hexagon:     100,
  Alpha:       200,
};

const near = (n: number, t: number, tol = 3) => Math.abs(n - t) <= tol;

class RadiusNormalizer {
  private samples: number[] = [];
  private factor = 1;              // raw * factor ≈ canonical
  private readonly max = 30;

  apply(raw: number): number {
    return raw * this.factor;
  }

  addAnchor(observedRaw: number, expectedCanon: number) {
    if (!Number.isFinite(observedRaw) || observedRaw <= 0) return;
    const f = expectedCanon / observedRaw;
    this.samples.push(f);
    if (this.samples.length > this.max) this.samples.shift();

    // robust median
    const s = [...this.samples].sort((a, b) => a - b);
    const m = s.length
      ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2)
      : 1;

    // gentle EMA
    this.factor = this.factor * 0.8 + m * 0.2;
  }

  anchorIfClose(observedRaw: number, expectedCanon: number, tol = 5) {
    const guess = this.apply(observedRaw);
    if (Math.abs(guess - expectedCanon) <= tol) this.addAnchor(observedRaw, expectedCanon);
  }
}

const radNorm = new RadiusNormalizer();

let lastPos: Vector | null = null;
let lastTime = 0;

/**
 * Entity Manager is used to access the information about the entities, that are currently drawn on the screen.
 * To access the entities the EntityManager exposes the EntityManager.entities field.
 */
class EntityManager extends Extension {
  #entities: Entity[] = [];
  #entitiesLastFrame: Entity[] = this.#entities;
  #lastFrameEndNow = performance.now();
  #lastGoodSelf: Entity | undefined;

  constructor() {
    super(() => {
      game.on('frame_end', () => {
        this.#lastFrameEndNow = performance.now(); // <-- add this
        this.#entitiesLastFrame = this.#entities;
        this.#entities = [];
      });

      this.#triangleHook();
      this.#squareHook();
      this.#pentagonHook();
      this.#hexagonHook();
      this.#playerHook();
    });
  }

  get entities(): Entity[] {
    return this.#entities;
  }

  /**
   * @returns The own player entity (simple, stable)
   */
  getPlayer(): Entity | undefined {
    // Phase 0: cached
    if (this.#lastGoodSelf?.position) {
      const d = Vector.distance(this.#lastGoodSelf.position, camera.position);
      if (d <= 160) return this.#lastGoodSelf;
    }

    // Phase 1: bootstrap (NO COLOR CHECK)
    let best: Entity | undefined;
    let bestRadius = -Infinity;

    for (const e of this.#entities) {
      if (e.extras?.source !== 'circle') continue;
      if (!Number.isFinite(e.position?.x)) continue;

      const d = Vector.distance(e.position, camera.position);
      if (d > 128) continue;

      const r = e.extras?.radius ?? 0;
      if (r > bestRadius) {
        bestRadius = r;
        best = e;
      }
    }

    // Phase 2: lock-in
    if (best) {
      this.#lastGoodSelf = best;
      return best;
    }

    return undefined;
  }

  /**
   * Adds/updates entity and merges extras; preserves both normalized and raw radius.
   */
  #add(
    type: EntityType,
    position: Vector,
    extras: Partial<Entity['extras']> & { radiusRaw?: number; source?: string },
  ): void {
    let entity = this.#findEntity(type, position);

    if (!entity) {
      const parent = this.#findParent(type, position);
      entity = new Entity(type, parent, {
        id: random_id(),
        timestamp: performance.now(),
      } as any);
    }

    if (extras.color !== undefined) entity.extras.color = extras.color as any;
    if (extras.radius !== undefined) entity.extras.radius = extras.radius;
    if (extras.radiusRaw !== undefined) (entity.extras as any).radiusRaw = extras.radiusRaw;
    if (extras.source !== undefined) entity.extras.source = extras.source as any;

    entity.updatePos(position);
    this.#entities.push(entity);
  }

  /**
   * If an entity is newly created, try to find it's parent entity.
   */
  #findParent(type: EntityType, position: Vector): Entity | undefined {
    if (type == EntityType.Bullet) {
      // TODO: do we want to change the parent entity to EntityType.Barrel in the future?
      return this.#findEntity(EntityType.Player, position, 300);
    }
  }

  /**
   * Searches `#entitiesLastFrame` for the entity that is closest to `position`
   * @returns the entity or null if there is no match.
   */
  #findEntity(type: EntityType, position: Vector, tolerance = 42): Entity | undefined {
    let result = undefined;
    let shortestDistance = Infinity;

    this.#entitiesLastFrame.forEach((entity) => {
      if (entity.type !== type) return;
      const distance = Vector.distance(entity.position, position);
      if (distance < shortestDistance) {
        shortestDistance = distance;
        result = entity;
      }
    });

    if (shortestDistance > tolerance) return undefined;
    return result;
  }

  // -------- Hooks --------

  #triangleHook(): void {
    CanvasKit.hookPolygon(3, (vertices, ctx) => {
      // Equilateral only → ignore minimap/leader arrows etc.
      const side1 = Math.round(Vector.distance(vertices[0], vertices[1]));
      const side2 = Math.round(Vector.distance(vertices[0], vertices[2]));
      const side3 = Math.round(Vector.distance(vertices[1], vertices[2]));
      if (side1 !== side2 || side2 !== side3) return;
      if ('#000000' === ctx.fillStyle) return; // ignore leader arrow

      const color = ctx.fillStyle as EntityColor;

      vertices = vertices.map((x) => scaling.toArenaPos(x));
      const position = Vector.centroid(...vertices);
      const raw = Vector.radius(...vertices);            // arena units
      const norm = Math.round(radNorm.apply(raw));       // canonicalized

      // Anchors (only when reliable)
      if (color === EntityColor.Crasher) {
        // choose small/large crasher by current guess
        if (norm <= (CANON.CrasherS + CANON.CrasherL) / 2) {
          radNorm.addAnchor(raw, CANON.CrasherS);
        } else {
          radNorm.addAnchor(raw, CANON.CrasherL);
        }
      } else if (color === EntityColor.Triangle) {
        radNorm.anchorIfClose(raw, CANON.Triangle, 6);
      } else if (TeamColors.includes(color)) {
        // Overseer/Overlord drones are ~45; only anchor if close
        radNorm.anchorIfClose(raw, CANON.DroneOver, 6);
        // (Battle/Base drones ~23/30 are rarer; anchor only when very close)
        radNorm.anchorIfClose(raw, CANON.DroneBattle, 3);
        radNorm.anchorIfClose(raw, CANON.DroneBase, 3);
      }

      // classify using normalized radius + color
      let type = EntityType.UNKNOWN;
      if (color === EntityColor.Crasher && (near(norm, CANON.CrasherS, 4) || near(norm, CANON.CrasherL, 6))) {
        type = EntityType.Crasher;
      } else if (TeamColors.includes(color)) {
        if (near(norm, CANON.DroneBattle, 3) || near(norm, CANON.DroneBase, 4) || near(norm, CANON.DroneOver, 6)) {
          type = EntityType.Drone;
        }
      } else if (color === EntityColor.Triangle && near(norm, CANON.Triangle, 6)) {
        type = EntityType.Triangle;
      }

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'triangle' });
    });
  }

  #squareHook(): void {
    CanvasKit.hookPolygon(4, (vertices, ctx) => {
      const color = ctx.fillStyle as EntityColor;

      vertices = vertices.map((x) => scaling.toArenaPos(x));
      const position = Vector.centroid(...vertices);
      const raw = Vector.radius(...vertices);
      const norm = Math.round(radNorm.apply(raw));

      // Very reliable anchor: gold squares
      if (color === EntityColor.Square) radNorm.addAnchor(raw, CANON.Square);

      let type = EntityType.UNKNOWN;
      if (color === EntityColor.Square && near(norm, CANON.Square, 5)) {
        type = EntityType.Square;
      } else if ((TeamColors.includes(color) || color === EntityColor.NecromancerDrone) && near(norm, CANON.Square, 7)) {
        type = EntityType.Drone;
      }

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'square' });
    });
  }

  #pentagonHook(): void {
    CanvasKit.hookPolygon(5, (vertices, ctx) => {
      // Widen to string to avoid enum narrowing issues (Pentagon/Alpha share same hex)
      const color = String(ctx.fillStyle);

      vertices = vertices.map((x) => scaling.toArenaPos(x));
      const position = Vector.centroid(...vertices);

      const raw = Vector.radius(...vertices);
      const norm = Math.round(radNorm.apply(raw)); // normalized back to classic units

      // Pentagon & AlphaPentagon use the same color. Choose anchor by SIZE (75 vs 200).
      const nearer =
        Math.abs(norm - CANON.Alpha) < Math.abs(norm - CANON.Pentagon)
          ? CANON.Alpha
          : CANON.Pentagon;
      radNorm.addAnchor(raw, nearer);

      // Classify by normalized radius
      let type = EntityType.UNKNOWN;
      if (near(norm, CANON.Alpha, 8))      type = EntityType.AlphaPentagon;
      else if (near(norm, CANON.Pentagon, 6)) type = EntityType.Pentagon;

      this.#add(type, position, {
        color,               // keep hex as string
        radius: norm,        // normalized
        radiusRaw: raw,      // keep true measured
        source: 'pentagon',
      });
    });
  }

  #hexagonHook(): void {
    CanvasKit.hookPolygon(6, (vertices, ctx) => {
      const color = ctx.fillStyle as EntityColor;

      vertices = vertices.map((x) => scaling.toArenaPos(x));
      const position = Vector.centroid(...vertices);
      const raw = Vector.radius(...vertices);
      const norm = Math.round(radNorm.apply(raw));

      if (color === EntityColor.Hexagon) radNorm.addAnchor(raw, CANON.Hexagon);

      let type = EntityType.UNKNOWN;
      if (color === EntityColor.Hexagon && near(norm, CANON.Hexagon, 6)) {
        type = EntityType.Hexagon;
      }

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'hexagon' });
    });
  }

  #playerHook(): void {
    let index = 0;
    let position: Vector;
    let color: string;
    let radius: number;

    const onCircle = () => {
      position = scaling.toArenaPos(position);
      const raw = scaling.toArenaUnits(new Vector(radius, radius)).x;
      const norm = Math.round(radNorm.apply(raw));

      let type = EntityType.UNKNOWN;
      if (norm > 53) type = EntityType.Player; else type = EntityType.Bullet;

      // players/bullets are not used as anchors (they vary a lot)
      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'circle' });
    };

    // Sequence: beginPath -> arc -> fill -> beginPath -> arc -> fill -> arc
    CanvasKit.hookCtx('beginPath', () => {
      if (index !== 3) { index = 1; return; }
      if (index === 3) { index++; return; }
      index = 0;
    });
    CanvasKit.hookCtx('arc', (_t, thisArg, _args) => {
      if (index === 1) {
        index++;
        const tr = thisArg.getTransform();
        position = new Vector(tr.e, tr.f);
        radius = tr.a;
        return;
      }
      if (index === 4) { index++; color = thisArg.fillStyle as string; return; }
      if (index === 6) { index++; onCircle(); return; }
      index = 0;
    });
    CanvasKit.hookCtx('fill', () => {
      if (index === 2) { index++; return; }
      if (index === 5) { index++; return; }
      index = 0;
    });
  }
}

export const entityManager = new EntityManager();
