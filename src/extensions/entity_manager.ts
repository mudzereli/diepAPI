import { game, scaling, camera } from '../apis';
import { CanvasKit, Vector } from '../core';
import { Entity, EntityColor, EntityType, TeamColors } from '../types/entity';
import { Extension } from './extension';

const random_id = () => Math.random().toString(36).slice(2, 5);
type RenderingContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

// --- canonical radii ---
const CANON = {
  DroneBattle: 23,
  DroneBase:   30,
  DroneOver:   45,
  CrasherS:    35,
  CrasherL:    55,
  Triangle:    55,
  Square:      55,
  Pentagon:    75,
  Hexagon:     100,
  Alpha:       200,
};

const near = (n: number, t: number, tol = 3) => Math.abs(n - t) <= tol;

/* ---------------- Radius Normalizer ---------------- */

class RadiusNormalizer {
  private samples: number[] = [];
  private factor = 1;
  private readonly max = 30;

  apply(raw: number): number {
    return raw * this.factor;
  }

  addAnchor(observedRaw: number, expectedCanon: number) {
    if (!Number.isFinite(observedRaw) || observedRaw <= 0) return;
    const f = expectedCanon / observedRaw;
    this.samples.push(f);
    if (this.samples.length > this.max) this.samples.shift();

    const s = [...this.samples].sort((a, b) => a - b);
    const m = s.length
      ? s.length % 2
        ? s[(s.length - 1) / 2]
        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
      : 1;

    this.factor = this.factor * 0.8 + m * 0.2;
  }

  anchorIfClose(observedRaw: number, expectedCanon: number, tol = 5) {
    if (Math.abs(this.apply(observedRaw) - expectedCanon) <= tol) {
      this.addAnchor(observedRaw, expectedCanon);
    }
  }
}

const radNorm = new RadiusNormalizer();

/* ---------------- Entity Manager ---------------- */

class EntityManager extends Extension {
  #entities: Entity[] = [];
  #entitiesLastFrame: Entity[] = [];
  #lastGoodSelf?: Entity;

  constructor() {
    super(() => {
      game.on('frame_end', () => {
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

  /* ---------------- Player Detection ---------------- */

  getPlayer(): Entity | undefined {
    if (this.#lastGoodSelf) {
      if (Vector.distance(this.#lastGoodSelf.position, camera.position) <= 160) {
        return this.#lastGoodSelf;
      }
    }

    let best: Entity | undefined;
    let bestRadius = -Infinity;

    for (const e of this.#entities) {
      if (e.extras?.source !== 'circle') continue;
      const d = Vector.distance(e.position, camera.position);
      if (d > 128) continue;

      const r = e.extras?.radius ?? 0;
      if (r > bestRadius) {
        bestRadius = r;
        best = e;
      }
    }

    if (best) this.#lastGoodSelf = best;
    return best;
  }

  /* ---------------- Entity Add / Match ---------------- */

  #add(
    type: EntityType,
    position: Vector,
    extras: Partial<Entity['extras']> & { radiusRaw?: number; source?: string },
  ) {
    let entity = this.#findEntity(type, position);

    if (!entity) {
      entity = new Entity(type, this.#findParent(type, position), {
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

  #findParent(type: EntityType, position: Vector) {
    if (type === EntityType.Bullet) {
      return this.#findEntity(EntityType.Player, position, 300);
    }
  }

  #findEntity(_type: EntityType, position: Vector, tol = 42) {
    let best: Entity | undefined;
    let bestD = Infinity;

    for (const e of this.#entitiesLastFrame) {
      const d = Vector.distance(e.position, position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }

    return bestD <= tol ? best : undefined;
  }

  /* ---------------- Polygon Hook Helper ---------------- */

  #polygonHook(
    sides: number,
    handler: (ctx: {
      ctx: RenderingContext;
      position: Vector;
      raw: number;
      norm: number;
      vertices: Vector[];
    }) => void,
  ) {
    CanvasKit.hookPolygon(sides, (verts, ctx) => {
      const vertices = verts.map(v => scaling.toArenaPos(v));
      const position = Vector.centroid(...vertices);
      const raw = Vector.radius(...vertices);
      const norm = Math.round(radNorm.apply(raw));
      handler({ ctx, position, raw, norm, vertices });
    });
  }

  /* ---------------- Polygon Hooks ---------------- */

  #triangleHook() {
    this.#polygonHook(3, ({ ctx, position, raw, norm, vertices }) => {
      const [a, b, c] = vertices;
      if (
        Math.round(Vector.distance(a, b)) !== Math.round(Vector.distance(a, c)) ||
        Math.round(Vector.distance(a, b)) !== Math.round(Vector.distance(b, c))
      ) return;

      if (ctx.fillStyle === '#000000') return;
      const color = ctx.fillStyle as EntityColor;

      if (color === EntityColor.Crasher) {
        radNorm.addAnchor(raw, norm < 45 ? CANON.CrasherS : CANON.CrasherL);
      } else if (color === EntityColor.Triangle) {
        radNorm.anchorIfClose(raw, CANON.Triangle, 6);
      } else if (TeamColors.includes(color)) {
        radNorm.anchorIfClose(raw, CANON.DroneOver, 6);
      }

      let type = EntityType.UNKNOWN;
      if (color === EntityColor.Crasher) type = EntityType.Crasher;
      else if (TeamColors.includes(color)) type = EntityType.Drone;
      else if (color === EntityColor.Triangle) type = EntityType.Triangle;

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'triangle' });
    });
  }

  #squareHook() {
    this.#polygonHook(4, ({ ctx, position, raw, norm }) => {
      const color = ctx.fillStyle as EntityColor;
      if (color === EntityColor.Square) radNorm.addAnchor(raw, CANON.Square);

      const type =
        color === EntityColor.Square
          ? EntityType.Square
          : TeamColors.includes(color)
          ? EntityType.Drone
          : EntityType.UNKNOWN;

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'square' });
    });
  }

  #pentagonHook() {
    this.#polygonHook(5, ({ ctx, position, raw, norm }) => {
      const color = String(ctx.fillStyle);
      radNorm.addAnchor(raw,
        Math.abs(norm - CANON.Alpha) < Math.abs(norm - CANON.Pentagon)
          ? CANON.Alpha
          : CANON.Pentagon
      );

      const type =
        near(norm, CANON.Alpha, 8)
          ? EntityType.AlphaPentagon
          : near(norm, CANON.Pentagon, 6)
          ? EntityType.Pentagon
          : EntityType.UNKNOWN;

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'pentagon' });
    });
  }

  #hexagonHook() {
    this.#polygonHook(6, ({ ctx, position, raw, norm }) => {
      const color = ctx.fillStyle as EntityColor;
      if (color === EntityColor.Hexagon) radNorm.addAnchor(raw, CANON.Hexagon);

      const type =
        color === EntityColor.Hexagon && near(norm, CANON.Hexagon, 6)
          ? EntityType.Hexagon
          : EntityType.UNKNOWN;

      this.#add(type, position, { color, radius: norm, radiusRaw: raw, source: 'hexagon' });
    });
  }

  /* ---------------- Player Hook ---------------- */

  #playerHook() {
    let index = 0;
    let position!: Vector;
    let radius = 0;
    let color = '';

    const onCircle = () => {
      const pos = scaling.toArenaPos(position);
      const raw = scaling.toArenaUnits(new Vector(radius, radius)).x;
      const norm = Math.round(radNorm.apply(raw));
      const type = norm > 53 ? EntityType.Player : EntityType.Bullet;

      this.#add(type, pos, { color, radius: norm, radiusRaw: raw, source: 'circle' });
    };

    CanvasKit.hookCtx('beginPath', () => index = index === 3 ? 4 : 1);
    CanvasKit.hookCtx('arc', (_t, ctx) => {
      if (index === 1) {
        const tr = ctx.getTransform();
        position = new Vector(tr.e, tr.f);
        radius = tr.a;
        index++;
      } else if (index === 4) {
        color = ctx.fillStyle as string;
        index++;
      } else if (index === 6) {
        onCircle();
        index = 0;
      }
    });
    CanvasKit.hookCtx('fill', () => index++);
  }
}

export const entityManager = new EntityManager();
