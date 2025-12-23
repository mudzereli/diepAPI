import { game, scaling, camera } from '../apis';
import { CanvasKit, Vector } from '../core';
import { Entity, EntityColor, EntityType, TeamColors } from '../types/entity';
import { Extension } from './extension';

/**
 * Generates a short random ID string for newly created entities.
 * NOTE: IDs are NOT stable across reloads — only within runtime.
 */
const random_id = () => Math.random().toString(36).slice(2, 5);

/**
 * CanvasKit can hook both onscreen and offscreen canvas contexts,
 * so we accept both here.
 */
type RenderingContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/* ============================================================
 *  CANONICAL RADII & TUNABLE CONSTANTS
 * ============================================================
 */

/**
 * Max distance (in arena units) an entity can move between frames
 * and still be considered "the same entity".
 *
 * Too small → entities flicker / lose identity
 * Too large → nearby entities may merge identities
 */
const FINDENTITY_TOLERANCE = 84;

/**
 * Canonical (historical) entity radii in arena units.
 * Used only for classification heuristics — NOT identity.
 */
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

/**
 * Helper: checks whether two numbers are approximately equal.
 * Used heavily for radius-based classification.
 */
const near = (n: number, t: number, tol = 3) =>
  Math.abs(n - t) <= tol;

/* ============================================================
 *  RADIUS NORMALIZER
 * ============================================================
 *
 * Purpose:
 * - Canvas scale / FOV changes distort raw radii
 * - This class learns a scale factor that maps raw → canonical
 *
 * IMPORTANT:
 * - Radius normalization affects classification ONLY
 * - Identity is NEVER radius-based
 */

class RadiusNormalizer {
  private samples: number[] = [];   // recent scale factor samples
  private factor = 1;               // current scale factor
  private readonly max = 15;         // max samples kept

  /**
   * Converts a raw measured radius into a normalized radius.
   */
  apply(raw: number) {
    return raw * this.factor;
  }

  /**
   * Adds a trusted (raw → canonical) measurement.
   * Uses a rolling median + EMA to remain stable.
   */
  addAnchor(observedRaw: number, expectedCanon: number) {
    if (!Number.isFinite(observedRaw) || observedRaw <= 0) return;

    // store scale ratio
    this.samples.push(expectedCanon / observedRaw);
    if (this.samples.length > this.max) this.samples.shift();

    // robust median
    const s = [...this.samples].sort((a, b) => a - b);
    const m =
      s.length % 2
        ? s[(s.length - 1) / 2]
        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;

    // smooth update (EMA)
    this.factor = this.factor * 0.8 + m * 0.2;
  }

  /**
   * Adds an anchor only if current estimate is already close.
   * Prevents bad anchors from corrupting scale.
   */
  anchorIfClose(raw: number, canon: number, tol = 5) {
    if (Math.abs(this.apply(raw) - canon) <= tol) {
      this.addAnchor(raw, canon);
    }
  }
}

const radNorm = new RadiusNormalizer();

/* ============================================================
 *  ENTITY MANAGER
 * ============================================================
 *
 * Core rules of this system:
 *
 * 1. Identity is POSITION-ONLY
 * 2. Type is FIXED AT CREATION
 * 3. Missing detection for 1 frame = entity disappears
 * 4. Extras are mutable, entity.type is not
 */

class EntityManager extends Extension {
  /**
   * Entities detected THIS frame
   */
  #entities: Entity[] = [];

  /**
   * Entities detected LAST frame
   * Used exclusively for identity matching
   */
  #entitiesLastFrame: Entity[] = [];

  /**
   * Cached "best guess" of player entity
   */
  #lastGoodSelf?: Entity;

  constructor() {
    super(() => {
      /**
       * At end of every frame:
       * - current entities become "last frame"
       * - current list is cleared
       */
      game.on('frame_end', () => {
        this.#entitiesLastFrame = this.#entities;
        this.#entities = [];
      });

      // Register all draw hooks
      this.#triangleHook();
      this.#squareHook();
      this.#pentagonHook();
      this.#hexagonHook();
      this.#playerHook();
    });
  }

  /**
   * Public accessor for entities detected THIS frame
   */
  get entities() {
    return this.#entities;
  }

  /* ============================================================
   *  IDENTITY MATCHING (POSITION ONLY)
   * ============================================================
   */

  /**
   * Finds the closest entity from the previous frame.
   *
   * This is the ONLY identity mechanism.
   * - type
   * - color
   * - radius
   * do NOT matter here.
   */
  #findEntity(position: Vector, tol = FINDENTITY_TOLERANCE): Entity | undefined {
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

  /**
   * Bullets attempt to parent to nearby players.
   * This is cosmetic / relational, not identity.
   */
  #findParent(type: EntityType, position: Vector) {
    if (type === EntityType.Bullet) {
      return this.#findEntity(position, 300);
    }
  }

  /**
   * Adds or updates an entity for THIS frame.
   *
   * - If position matches previous frame → reuse entity
   * - Otherwise → create a new one
   *
   * NOTE:
   * entity.type is NEVER modified after creation.
   */
  #add(
    type: EntityType,
    position: Vector,
    extras: Partial<Entity['extras']> & { radiusRaw?: number; source?: string },
  ) {
    let entity = this.#findEntity(position);

    // Create entity ONLY if identity not found
    if (!entity) {
      entity = new Entity(type, this.#findParent(type, position), {
        id: random_id(),
        timestamp: performance.now(),
      } as any);
    }

    // Mutable metadata only
    if (extras.color !== undefined) entity.extras.color = extras.color as any;
    if (extras.radius !== undefined) entity.extras.radius = extras.radius;
    if (extras.radiusRaw !== undefined) (entity.extras as any).radiusRaw = extras.radiusRaw;
    if (extras.source !== undefined) entity.extras.source = extras.source as any;

    // Update position every frame
    entity.updatePos(position);

    this.#entities.push(entity);
  }

  /* ============================================================
   *  PLAYER DETECTION
   * ============================================================
   *
   * Chooses the largest nearby circle entity.
   * Cached to avoid flicker.
   */

  getPlayer(): Entity | undefined {
    if (this.#lastGoodSelf) {
      if (Vector.distance(this.#lastGoodSelf.position, camera.position) <= 160) {
        return this.#lastGoodSelf;
      }
    }

    let best: Entity | undefined;
    let bestR = -Infinity;

    for (const e of this.#entities) {
      if (e.extras?.source !== 'circle') continue;
      const d = Vector.distance(e.position, camera.position);
      if (d > 128) continue;

      const r = e.extras.radius ?? 0;
      if (r > bestR) {
        bestR = r;
        best = e;
      }
    }

    if (best) this.#lastGoodSelf = best;
    return best;
  }

  /* ============================================================
   *  POLYGON HOOK INFRASTRUCTURE
   * ============================================================
   *
   * Shared logic for all polygon types:
   * - Receives raw canvas vertices
   * - Computes centroid + radius
   * - Hands off to shape-specific handler
   */

  #polygonHook(
    sides: number,
    handler: (p: {
      ctx: RenderingContext;
      position: Vector;
      raw: number;
      norm: number;
      vertices: Vector[];
    }) => void,
  ) {
    CanvasKit.hookPolygon(sides, (verts, ctx) => {
      const vertices = verts.map(v => scaling.toArenaPos(v)); // canvas-space vertices
      const position = Vector.centroid(...vertices);
      const raw = Vector.radius(...vertices);
      const norm = Math.round(radNorm.apply(raw));

      handler({ ctx, position, raw, norm, vertices });
    });
  }

  /* ============================================================
   *  SHAPE-SPECIFIC HOOKS
   * ============================================================
   */

  /**
   * TRIANGLES:
   * - Crasher
   * - Triangle
   * - Drones
   *
   * NOTE:
   * Equilateral check is VERY strict and can cause flicker.
   */
  #triangleHook() {
    this.#polygonHook(3, ({ ctx, position, raw, norm, vertices }) => {
      const [a, b, c] = vertices;

      // Reject non-equilateral triangles
      if (
        Math.round(Vector.distance(a, b)) !== Math.round(Vector.distance(a, c)) ||
        Math.round(Vector.distance(a, b)) !== Math.round(Vector.distance(b, c))
      ) return;

      // Ignore leader arrows
      if (ctx.fillStyle === '#000000') return;

      const color = ctx.fillStyle as EntityColor;
      let type = EntityType.UNKNOWN;

      if (color === EntityColor.Crasher) {
        if (near(norm, CANON.CrasherS, 4) || near(norm, CANON.CrasherL, 6)) {
          type = EntityType.Crasher;
        }
      } else if (color === EntityColor.Triangle && near(norm, CANON.Triangle, 6)) {
        type = EntityType.Triangle;
      } else if (
        TeamColors.includes(color) &&
        (near(norm, CANON.DroneBattle, 3) ||
         near(norm, CANON.DroneBase, 4) ||
         near(norm, CANON.DroneOver, 6))
      ) {
        type = EntityType.Drone;
      }

      this.#add(type, position, {
        color,
        radius: norm,
        radiusRaw: raw,
        source: 'triangle',
      });
    });
  }

  /* SQUARES */
  #squareHook() {
    this.#polygonHook(4, ({ ctx, position, raw, norm }) => {
      const color = ctx.fillStyle as EntityColor;
      if (color === EntityColor.Square) radNorm.addAnchor(raw, CANON.Square);

      let type = EntityType.UNKNOWN;
      if (color === EntityColor.Square && near(norm, CANON.Square, 5)) {
        type = EntityType.Square;
      } else if (
        (TeamColors.includes(color) || color === EntityColor.NecromancerDrone) &&
        near(norm, CANON.Square, 7)
      ) {
        type = EntityType.Drone;
      }

      this.#add(type, position, {
        color,
        radius: norm,
        radiusRaw: raw,
        source: 'square',
      });
    });
  }

  /* PENTAGONS / ALPHA */
  #pentagonHook() {
    this.#polygonHook(5, ({ ctx, position, raw, norm }) => {
      radNorm.addAnchor(
        raw,
        Math.abs(norm - CANON.Alpha) < Math.abs(norm - CANON.Pentagon)
          ? CANON.Alpha
          : CANON.Pentagon,
      );

      let type = EntityType.UNKNOWN;
      if (near(norm, CANON.Alpha, 8)) type = EntityType.AlphaPentagon;
      else if (near(norm, CANON.Pentagon, 6)) type = EntityType.Pentagon;

      this.#add(type, position, {
        color: String(ctx.fillStyle),
        radius: norm,
        radiusRaw: raw,
        source: 'pentagon',
      });
    });
  }

  /* HEXAGONS */
  #hexagonHook() {
    this.#polygonHook(6, ({ ctx, position, raw, norm }) => {
      const color = ctx.fillStyle as EntityColor;
      if (color === EntityColor.Hexagon) radNorm.addAnchor(raw, CANON.Hexagon);

      const type =
        color === EntityColor.Hexagon && near(norm, CANON.Hexagon, 6)
          ? EntityType.Hexagon
          : EntityType.UNKNOWN;

      this.#add(type, position, {
        color,
        radius: norm,
        radiusRaw: raw,
        source: 'hexagon',
      });
    });
  }

  /* ============================================================
   *  PLAYER / BULLET CIRCLE HOOK
   * ============================================================
   */

  #playerHook() {
    let index = 0;
    let position!: Vector;
    let radius = 0;
    let color = '';

    /**
     * Called when full arc + fill sequence completes.
     */
    const onCircle = () => {
      const pos = scaling.toArenaPos(position);
      const raw = scaling.toArenaUnits(new Vector(radius, radius)).x;
      const norm = Math.round(radNorm.apply(raw));
      const type = norm > 53 ? EntityType.Player : EntityType.Bullet;

      this.#add(type, pos, {
        color,
        radius: norm,
        radiusRaw: raw,
        source: 'circle',
      });
    };

    // Canvas state machine for arc → fill → arc
    CanvasKit.hookCtx('beginPath', () => {
      if (index !== 3) { index = 1; return; }
      if (index === 3) { index++; return; }
      index = 0;
    });

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
