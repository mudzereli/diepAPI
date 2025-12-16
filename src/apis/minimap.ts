// FILE: src/apis/minimap.ts
import { CanvasKit } from '../core/canvas_kit';
import { Vector } from '../core/vector';
import { game } from './game';
import { overlay } from '../tools/overlay';

// tuning
const ARROW_EASE = 0.25; // smoothing for inferred arrow updates
const SYNTHETIC_VIEWPORT_FRACTION = 0.22; // same scale as before

class Minimap {
  #minimapDim = new Vector(1, 1);
  #minimapPos = new Vector(0, 0);

  #viewportDim = new Vector(1, 1);
  #viewportPos = new Vector(1, 1);

  #arrowPos = new Vector(0.5, 0.5);

  #drawViewport = false;
  #drawViewportOverlayEnabled = true;

  // internal state
  #hadViewportThisFrame = false;
  #hadArrowThisFrame = false;

  constructor() {
    game.once('ready', () => {
      const w = _window as any;
      if (w.input == null) throw new Error('diepAPI: window.input does not exist.');
      w.input.set_convar('ren_minimap_viewport', 'true');
      w.input.set_convar = new Proxy(w.input.set_convar, {
        apply: (target: any, thisArg: any, args: unknown[]) => {
          if (args[0] === 'ren_minimap_viewport') {
            this.#drawViewport = Boolean(args[1]);
            return;
          }
          return Reflect.apply(target, thisArg, args as any);
        },
      });
    });

    this.#minimapHook();
    this.#viewportHook();
    this.#arrowHook();

    game.on('frame_start', () => {
      this.#hadViewportThisFrame = false;
      this.#hadArrowThisFrame = false;
    });

    game.on('frame_end', () => {
      this.#maybeInferArrowFromEntities();
      this.#synthesizeViewportUnbounded();
    });

    game.on('frame', () => this.#renderViewportOverlay());
  }

  enableViewportOverlay(v: boolean): void { this.#drawViewportOverlayEnabled = v; }

  get minimapDim(): Vector { return this.#minimapDim; }
  get minimapPos(): Vector { return this.#minimapPos; }
  get viewportDim(): Vector { return this.#viewportDim; }
  get viewportPos(): Vector { return this.#viewportPos; }
  get arrowPos(): Vector { return this.#arrowPos; }

  #minimapHook() {
    const handle = (_target: any, thisArg: any) => {
      if (!thisArg || typeof thisArg.getTransform !== 'function') return;
      const tr: DOMMatrix = thisArg.getTransform();
      this.#minimapDim = new Vector(tr.a, tr.d);
      this.#minimapPos = new Vector(tr.e, tr.f);
    };
    CanvasKit.hookCtx('strokeRect', handle, false);
    CanvasKit.hookCtx('strokeRect', handle, true);
  }

  #viewportHook() {
    let bestScore = Infinity;
    const winAsp = () => _window.innerWidth / _window.innerHeight;

    const rectWithTransform = (
      ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      x: number, y: number, w: number, h: number
    ) => {
      const tr = ctx.getTransform();
      const px = tr.a * x + tr.c * y + tr.e;
      const py = tr.b * x + tr.d * y + tr.f;
      const sx = Math.hypot(tr.a, tr.b);
      const sy = Math.hypot(tr.c, tr.d);
      return { px, py, effW: Math.abs((w || 1) * sx), effH: Math.abs((h || 1) * sy) };
    };

    const setDebug = (accepted: boolean, src: string, ctx: any, px?: number, py?: number, w?: number, h?: number, reason?: string) => {
      (this as any).viewportDebug = {
        accepted,
        src,
        pos: (Number.isFinite(px) && Number.isFinite(py)) ? { x: +(px as number).toFixed(1), y: +(py as number).toFixed(1) } : undefined,
        dim: (Number.isFinite(w) && Number.isFinite(h)) ? { w: +(w as number).toFixed(1), h: +(h as number).toFixed(1) } : undefined,
        alpha: Number.isFinite(ctx?.globalAlpha) ? +ctx.globalAlpha.toFixed(3) : NaN,
        rectAsp: (Number.isFinite(w) && Number.isFinite(h)) ? +((w as number) / Math.max(1e-6, h as number)).toFixed(3) : undefined,
        reason: reason ?? ''
      };
    };

    const scoreCandidate = (w: number, h: number) => {
      const asp = w / Math.max(1e-6, h);
      const aspErr = Math.abs(asp - winAsp()) / Math.max(1e-6, winAsp());
      // prefer “mid” sizes; still keep very large/small from dominating
      const miniA = Math.max(1, this.#minimapDim.x * this.#minimapDim.y);
      const aRatio = (w * h) / miniA;
      const sizePenalty = Math.abs(aRatio - 0.22) * 0.6;
      return aspErr * 10 + sizePenalty; // lower wins
    };

    const accept = (px: number, py: number, w: number, h: number, src: string, ctx: any) => {
      this.#viewportPos = new Vector(px, py);
      this.#viewportDim = new Vector(w, h);
      this.#hadViewportThisFrame = true;
      setDebug(true, src, ctx, px, py, w, h);
    };

    const evaluateRect = (
      ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      px: number, py: number, w: number, h: number, src: string
    ) => {
      if (![px, py, w, h].every(Number.isFinite)) { setDebug(false, src, ctx, px, py, w, h, 'non-finite'); return; }

      // reject fullscreen/near-fullscreen final blits
      const nearCanvas = (val: number, target: number) => Math.abs(val - target) < 4;
      const isFullscreen =
        nearCanvas(px, 0) && nearCanvas(py, 0) &&
        nearCanvas(w, _window.innerWidth) && nearCanvas(h, _window.innerHeight);
      if (isFullscreen) { setDebug(false, src, ctx, px, py, w, h, 'fullscreen'); return; }

      // DO NOT require being inside the minimap; allow out-of-bounds viewports.
      // only sanity-check aspect and rough size vs minimap area
      const mw = this.#minimapDim.x, mh = this.#minimapDim.y;
      if (!(mw > 0 && mh > 0)) { setDebug(false, src, ctx, px, py, w, h, 'minimap-unset'); return; }

      const miniA = mw * mh;
      const aRatio = (w * h) / Math.max(1, miniA);
      if (aRatio < 0.001 || aRatio > 4.0) { // allow very large (outside), but cap absurd
        setDebug(false, src, ctx, px, py, w, h, 'areaRatio');
        return;
      }

      const asp = w / Math.max(1e-6, h);
      const relErr = Math.abs(asp - winAsp()) / Math.max(1e-6, winAsp());
      if (relErr > 0.18) { setDebug(false, src, ctx, px, py, w, h, 'aspect'); return; }

      const sc = scoreCandidate(w, h);
      if (sc >= bestScore) return;
      bestScore = sc;
      accept(px, py, w, h, src, ctx);
    };

    const intrinsicSize = (img: any) => {
      const w = img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? img?.displayWidth ?? 1;
      const h = img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? img?.displayHeight ?? 1;
      return { w: Number(w) || 1, h: Number(h) || 1 };
    };

    const register = (useOffscreen: boolean) => {
      let lastRect: { x: number; y: number; w: number; h: number } | null = null;

      CanvasKit.hookCtx('beginPath', () => { lastRect = null; }, useOffscreen);

      CanvasKit.hookCtx('rect', (_t: any, _ctx: any, a: any[]) => {
        lastRect = { x: a[0] as number, y: a[1] as number, w: a[2] as number, h: a[3] as number };
      }, useOffscreen);

      CanvasKit.hookCtx('fill', (_t: any, _ctx: any) => {
        if (!lastRect || !_ctx?.getTransform) return;
        const { px, py, effW, effH } = rectWithTransform(_ctx, lastRect.x, lastRect.y, lastRect.w, lastRect.h);
        evaluateRect(_ctx, px, py, effW, effH, 'rect+fill');
      }, useOffscreen);

      CanvasKit.hookCtx('stroke', (_t: any, _ctx: any) => {
        if (!lastRect || !_ctx?.getTransform) return;
        const { px, py, effW, effH } = rectWithTransform(_ctx, lastRect.x, lastRect.y, lastRect.w, lastRect.h);
        evaluateRect(_ctx, px, py, effW, effH, 'rect+stroke');
      }, useOffscreen);

      CanvasKit.hookCtx('strokeRect', (_t: any, _ctx: any, a: any[]) => {
        if (!_ctx?.getTransform) return;
        const { px, py, effW, effH } = rectWithTransform(_ctx, a[0] as number, a[1] as number, a[2] as number, a[3] as number);
        evaluateRect(_ctx, px, py, effW, effH, 'strokeRect');
      }, useOffscreen);

      CanvasKit.overrideCtx('fillRect', (target: any, _ctx: any, a: unknown[]) => {
        const dx = (a[0] as number) ?? 0, dy = (a[1] as number) ?? 0;
        const dw = (a[2] as number) ?? 0, dh = (a[3] as number) ?? 0;
        if (_ctx?.getTransform) {
          const { px, py, effW, effH } = rectWithTransform(_ctx, dx, dy, dw, dh);
          evaluateRect(_ctx, px, py, effW, effH, 'fillRect');
        }
        return Reflect.apply(target, _ctx, a);
      }, useOffscreen);

      CanvasKit.hookCtx('drawImage', (_t: any, _ctx: any, a: any[]) => {
        if (!_ctx?.getTransform) return;

        let dx = 0, dy = 0, dw: number | null = null, dh: number | null = null;
        const img = a[0];

        if (a.length === 3) { dx = a[1]; dy = a[2]; const s = intrinsicSize(img); dw = s.w; dh = s.h; }
        else if (a.length === 5) { dx = a[1]; dy = a[2]; dw = a[3]; dh = a[4]; }
        else if (a.length === 9) { dx = a[5]; dy = a[6]; dw = a[7]; dh = a[8]; }
        else { return; }

        const { px, py, effW, effH } = rectWithTransform(_ctx, dx, dy, (dw ?? 1), (dh ?? 1));
        evaluateRect(_ctx, px, py, effW, effH, 'drawImage');
      }, useOffscreen);
    };

    register(false);
    register(true);
  }

  // Unbounded synthetic viewport: center on arrow, no clamps
  #synthesizeViewportUnbounded(): void {
    if (this.#hadViewportThisFrame) return;

    const mx = this.#minimapPos.x, my = this.#minimapPos.y;
    const mw = this.#minimapDim.x, mh = this.#minimapDim.y;
    if (!(mw > 2 && mh > 2)) return;

    const asp = _window.innerWidth / _window.innerHeight;
    const ax = mx + this.#arrowPos.x * mw;
    const ay = my + this.#arrowPos.y * mh;

    let vh = mh * SYNTHETIC_VIEWPORT_FRACTION;
    let vw = vh * asp;
    if (vw > mw) { const k = mw / vw; vw *= k; vh *= k; } // keep relative scale stable

    const px = ax - vw / 2;
    const py = ay - vh / 2;

    this.#viewportPos = new Vector(px, py);
    this.#viewportDim = new Vector(vw, vh);

    (this as any).viewportDebug = {
      accepted: true,
      src: 'synthetic-unbounded',
      pos: { x: +px.toFixed(1), y: +py.toFixed(1) },
      dim: { w: +vw.toFixed(1), h: +vh.toFixed(1) },
      alpha: 1.0,
      rectAsp: +(vw / Math.max(1e-6, vh)).toFixed(3),
      reason: 'fallback-unbounded'
    };
  }

  // Arrow hook: marks frames where arrow is detected
  #arrowHook(): void {
    type Pt = { x: number; y: number };
    let pathPoints: Pt[] = [];
    let lastNorm: Pt = { x: 0.5, y: 0.5 };
    let bestScore = Infinity;
    game.on('frame_start', () => { bestScore = Infinity; });

    const insideMinimap = (x: number, y: number): boolean =>
      x >= this.#minimapPos.x &&
      y >= this.#minimapPos.y &&
      x <= this.#minimapPos.x + this.#minimapDim.x &&
      y <= this.#minimapPos.y + this.#minimapDim.y;

    const tf = (tr: DOMMatrix, p: Pt): Pt => ({ x: tr.a * p.x + tr.c * p.y + tr.e, y: tr.b * p.x + tr.d * p.y + tr.f });
    const bbox = (pts: Pt[]) => {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const p of pts) { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y; }
      return { minx, maxx, miny, maxy, w: maxx - minx, h: maxy - miny };
    };
    const polyAreaAbs = (pts: Pt[]): number => {
      let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      return Math.abs(a) * 0.5;
    };
    const polyCentroid = (pts: Pt[]): Pt => {
      let A = 0, cx = 0, cy = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y; A += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f; }
      A *= 0.5;
      if (Math.abs(A) < 1e-6) {
        const n = Math.max(1, pts.length);
        const sx = pts.reduce((s, p) => s + p.x, 0);
        const sy = pts.reduce((s, p) => s + p.y, 0);
        return { x: sx / n, y: sy / n };
      }
      return { x: cx / (6 * A), y: cy / (6 * A) };
    };
    const ema = (p: number, n: number, a: number) => p + a * (n - p);
    const asCss = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

    const consider = (ctx: any, tr: DOMMatrix, from: 'fill' | 'stroke') => {
      if (pathPoints.length < 3) return;
      if (!ctx || typeof ctx.getTransform !== 'function') return;

      const tpts = pathPoints.map(p => tf(tr, p));
      const bb = bbox(tpts);
      const miniArea = this.#minimapDim.x * this.#minimapDim.y;
      const area = polyAreaAbs(tpts);
      const areaRatio = miniArea > 0 ? area / miniArea : 0;

      const paint = from === 'fill' ? ctx.fillStyle : ctx.strokeStyle;
      const isBlack = asCss(paint) === '#000000' || asCss(paint) === 'black';
      if (!isBlack) return;

      const cx = (bb.minx + bb.maxx) * 0.5, cy = (bb.miny + bb.maxy) * 0.5;
      if (!insideMinimap(cx, cy)) return;
      if (bb.w < 1 || bb.h < 1 || bb.w > 40 || bb.h > 40) return;
      if (!(areaRatio > 1e-7 && areaRatio < 6e-2)) return;

      const cen = polyCentroid(tpts);
      const nx = (cen.x - this.#minimapPos.x) / this.#minimapDim.x;
      const ny = (cen.y - this.#minimapPos.y) / this.#minimapDim.y;
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

      const distToLast = Math.hypot(nx - lastNorm.x, ny - lastNorm.y);
      const score = areaRatio * 1000 + distToLast * 0.05;
      if (score >= bestScore) return;
      bestScore = score;

      const maxStep = 0.18;
      const dx = nx - lastNorm.x, dy = ny - lastNorm.y;
      const jump = Math.hypot(dx, dy);
      const tx = jump > maxStep ? lastNorm.x + (dx / jump) * maxStep : nx;
      const ty = jump > maxStep ? lastNorm.y + (dy / jump) * maxStep : ny;

      const smx = ema(lastNorm.x, tx, 0.35);
      const smy = ema(lastNorm.y, ty, 0.35);

      this.#arrowPos = new Vector(smx, smy);
      lastNorm = { x: smx, y: smy };
      this.#hadArrowThisFrame = true;

      (this as any).debug = {
        accepted: true, src: from,
        pts: pathPoints.length,
        bbox: { w: +bb.w.toFixed(2), h: +bb.h.toFixed(2) },
        areaRatio: +areaRatio.toExponential(2),
        raw: { nx: +nx.toFixed(3), ny: +ny.toFixed(3) },
        smoothed: { x: +smx.toFixed(3), y: +smy.toFixed(3) },
        score: +score.toFixed(3)
      };
    };

    const register = (useOffscreen: boolean) => {
      CanvasKit.hookCtx('beginPath', () => { pathPoints = []; }, useOffscreen);
      CanvasKit.hookCtx('moveTo',   (_t: any, _ctx: any, args: any[]) => { pathPoints.push({ x: args[0] as number, y: args[1] as number }); }, useOffscreen);
      CanvasKit.hookCtx('lineTo',   (_t: any, _ctx: any, args: any[]) => { pathPoints.push({ x: args[0] as number, y: args[1] as number }); }, useOffscreen);
      CanvasKit.hookCtx('fill',     (_t: any, thisArg: any) => { if (thisArg?.getTransform) consider(thisArg, thisArg.getTransform(), 'fill'); },   useOffscreen);
      CanvasKit.hookCtx('stroke',   (_t: any, thisArg: any) => { if (thisArg?.getTransform) consider(thisArg, thisArg.getTransform(), 'stroke'); }, useOffscreen);
    };

    register(false);
    register(true);
  }

  // Arrow inference from entities when arrow is off-screen / lost (no clamping)
  #maybeInferArrowFromEntities(): void {
    try {
      // only infer if arrow wasn't updated this frame
      if (this.#hadArrowThisFrame) return;

      const w: any = _window;
      const em = w?.diepAPI?.extensions?.entityManager;
      const arena = w?.diepAPI?.apis?.arena;
      const VectorApi = w?.diepAPI?.core?.Vector || Vector;

      if (!em || !arena) return;

      const pm = w?.diepAPI?.apis?.playerMovement?.position;
      const entities: any[] = Array.isArray(em.entities) ? em.entities : [];
      if (!entities.length) return;

      // Prefer 'circle' source (player body) then anything nearest to pm
      let candidates = entities.filter((e: any) => e?.extras?.source === 'circle' && e?.position);
      if (!candidates.length) candidates = entities.filter((e: any) => e?.position);
      if (!candidates.length) return;

      let best = candidates[0];
      if (pm && Number.isFinite(pm.x) && Number.isFinite(pm.y)) {
        let bestD = Infinity;
        for (const e of candidates) {
          const d = VectorApi.distance(pm, e.position);
          if (d < bestD) { bestD = d; best = e; }
        }
      }

      const norm = arena.unscale(best.position); // may be <0 or >1 near edges
      const smx = this.#arrowPos.x + ARROW_EASE * (norm.x - this.#arrowPos.x);
      const smy = this.#arrowPos.y + ARROW_EASE * (norm.y - this.#arrowPos.y);
      this.#arrowPos = new Vector(smx, smy);

      (this as any).debug = {
        ...(this as any).debug,
        inferred: true,
        via: 'entities',
        rawNorm: { x: +norm.x.toFixed(3), y: +norm.y.toFixed(3) }
      };
    } catch { /* noop */ }
  }

  #renderViewportOverlay(): void {
    if (!this.#drawViewportOverlayEnabled) return;

    const ctx = overlay.ctx;
    const DPR = _window.devicePixelRatio || 1;

    const mx = this.#minimapPos.x, my = this.#minimapPos.y;
    const mw = this.#minimapDim.x, mh = this.#minimapDim.y;
    if (![mx, my, mw, mh].every(Number.isFinite) || mw < 2 || mh < 2) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    // minimap outline
    ctx.lineWidth = Math.max(1, 1.25 * DPR);
    ctx.strokeStyle = '#49a7ff';
    ctx.setLineDash([4 * DPR, 3 * DPR]);
    ctx.strokeRect(mx, my, mw, mh);

    // viewport rect — ALWAYS draw, even if entirely outside the minimap box
    const px = this.#viewportPos.x, py = this.#viewportPos.y;
    const vw = this.#viewportDim.x, vh = this.#viewportDim.y;
    if ([px, py, vw, vh].every(Number.isFinite) && vw >= 2 && vh >= 2) {
      ctx.setLineDash([6 * DPR, 4 * DPR]);
      ctx.lineWidth = Math.max(1, 1.75 * DPR);
      ctx.strokeStyle = '#00ffc3';
      ctx.strokeRect(px, py, vw, vh);

      const cx = px + vw / 2, cy = py + vh / 2, r = 8 * DPR;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.strokeStyle = '#00ffc3';
      ctx.stroke();

      ctx.font = `${10 * DPR}px ui-monospace, monospace`;
      ctx.fillStyle = '#00ffc3';
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 3;
      const label = `viewport ${Math.round(vw)}×${Math.round(vh)}`;
      ctx.strokeText(label, px + 4 * DPR, py - 6 * DPR);
      ctx.fillText(label,  px + 4 * DPR, py - 6 * DPR);
    }

    // arrow marker (can be outside [0..1]; we still draw its pixel location)
    const a = this.#arrowPos;
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) {
      const ax = mx + a.x * mw;
      const ay = my + a.y * mh;
      const r = 3.5 * DPR;
      ctx.beginPath();
      ctx.arc(ax, ay, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1 * DPR);
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }

    ctx.restore();
  }
}

export const minimap = new Minimap();
