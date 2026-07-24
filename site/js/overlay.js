// Town overlay: building footprints drawn on a 2D canvas that sits exactly
// on top of the GL view — the main map gets the whole town as small
// type-colored rects; a corner inset shows the town close up, with the GL
// display pass re-drawn underneath it (live water) through a zoomed UV
// window. NOT physics: pure presentation over frozen town data.
//
// Coordinate convention (the one thing to get right): every world position
// goes through texture-uv space with TEXEL-CENTER mapping,
//     u = ((x - xmin)/dx + 0.5) / n
// because that is where the display shader actually samples cell (i, j).
// At the main view's scale a half-texel is invisible, but the inset zooms
// ~25x and buildings would visibly slide off the waterline if the overlay
// and the GL window disagreed. j = 0 is the SOUTH row; the screen draws
// north-up, so v flips to css y. No other flips anywhere (repo rule).

/** Texel-center uv of a world position on the solver grid. */
export function uvOf(grid, x, y) {
    return {
        u: ((x - grid.xmin) / grid.dx + 0.5) / grid.n,
        v: ((y - grid.ymin) / grid.dx + 0.5) / grid.n,
    };
}

/** The inset's GL texture window {uv0:[u,v], uv1:[u,v]} for u_uv0/u_uv1. */
export function uvWindow(win, grid) {
    const a = uvOf(grid, win.x0, win.y0);
    const b = uvOf(grid, win.x1, win.y1);
    return { uv0: [a.u, a.v], uv1: [b.u, b.v] };
}

/** Pick the inset's domain window: the town core (median center, p90
 *  radius) widened to include the local shoreline west of downtown — the
 *  wave must be visible ARRIVING, not only after it lands. Square, clamped
 *  to the domain. */
export function computeInsetWindow(bed, grid, town) {
    const fp = town.footprint();
    const clampI = (i) => Math.max(0, Math.min(grid.n - 1, i));
    const j = clampI(Math.round((fp.cy - grid.ymin) / grid.dx));
    let shoreX = fp.cx - 2000.0;   // fallback: just look a bit seaward
    for (let i = clampI(Math.round((fp.cx - grid.xmin) / grid.dx));
         i >= 0; i--) {
        if (bed[j * grid.n + i] < 0.0) {
            shoreX = grid.xmin + i * grid.dx;
            break;
        }
    }
    const half = Math.max(1600.0, fp.r * 1.4);
    let x0 = Math.min(shoreX - 600.0, fp.cx - half);
    let x1 = fp.cx + half;
    const side = x1 - x0;
    let y0 = fp.cy - side / 2;
    let y1 = fp.cy + side / 2;
    // Clamp by shifting (window keeps its size; the domain is far larger).
    const xmax = grid.xmin + (grid.n - 1) * grid.dx;
    const ymax = grid.ymin + (grid.n - 1) * grid.dx;
    if (x0 < grid.xmin) { x1 += grid.xmin - x0; x0 = grid.xmin; }
    if (x1 > xmax) { x0 -= x1 - xmax; x1 = xmax; }
    if (y0 < grid.ymin) { y1 += grid.ymin - y0; y0 = grid.ymin; }
    if (y1 > ymax) { y0 -= y1 - ymax; y1 = ymax; }
    return { x0, x1, y0, y1 };
}

const INSET_MARGIN = 8;      // css px from the canvas corner
const INSET_FRACTION = 0.38; // of canvas width
const INSET_MIN = 170, INSET_MAX = 280;

// Road ribbon widths (m), mirror of roads.KIND_WIDTH_M, and their 2D
// styling. Streets are a faint gray mesh; the shore road is warm; the
// ARTERIALS are the evacuation story, so they read gold and heavy. Index
// = kind (0 street / 1 shore / 2 arterial).
const ROAD_WIDTH_M = [7.0, 8.0, 10.0];
const ROAD_COLOR = [
    "rgba(72,76,84,0.5)",     // street
    "rgba(156,124,58,0.75)",  // shore road
    "rgba(233,172,42,0.92)",  // arterial (evacuation route)
];

export class TownOverlay {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.grid = null;      // {n, dx, xmin, ymin}
        this.win = null;       // inset domain window
        this.cssW = 0;
        this.cssH = 0;
        this._typeFill = {};   // type name -> css color
    }

    setGrid(grid) { this.grid = grid; }
    setWindow(win) { this.win = win; }

    resize(cssW, cssH, dpr) {
        this.cssW = cssW;
        this.cssH = cssH;
        this.canvas.width = Math.round(cssW * dpr);
        this.canvas.height = Math.round(cssH * dpr);
        // Draw in css px regardless of backing resolution.
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Inset placement in css px (top-left corner: deep ocean — the town
     *  and its coast sit on the right of this map). */
    insetRect() {
        const w = Math.max(INSET_MIN,
                  Math.min(INSET_MAX, Math.round(this.cssW * INSET_FRACTION)));
        return { x: INSET_MARGIN, y: INSET_MARGIN, w, h: w };
    }

    _fillFor(b) {
        let c = this._typeFill[b.t];
        if (!c) {
            const [r, g, bl] = b.type.color;
            c = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},` +
                `${Math.round(bl * 255)})`;
            this._typeFill[b.t] = c;
        }
        return c;
    }

    /** Draw everything. colorOf(k, building) -> css color | null lets the
     *  damage milestone recolor buildings without touching this module;
     *  null/omitted means type colors. */
    render(town, colorOf = null) {
        const { ctx, grid, win } = this;
        ctx.clearRect(0, 0, this.cssW, this.cssH);
        if (!town || !grid) return;

        // --- Main view: uv (0,0)..(1,1) fills the canvas, north up.
        const mainView = {
            px: (u, v) => [u * this.cssW, (1 - v) * this.cssH],
            scale: this.cssW / (grid.n * grid.dx),   // px per meter
            minPx: 2.0,
        };
        // Roads first, buildings on top. On the whole-map view the street
        // lattice is sub-pixel, so its floor is thin (a faint mesh) while
        // the arterials stay visible leading inland to high ground.
        this._drawRoads(town, mainView, [0.4, 1.0, 1.6]);
        this._drawBuildings(town, mainView, colorOf);

        if (!win) return;
        const rect = this.insetRect();
        const { uv0, uv1 } = uvWindow(win, grid);

        // Locator on the main map: where the inset window sits.
        const [lx0, ly1] = mainView.px(uv0[0], uv0[1]);
        const [lx1, ly0] = mainView.px(uv1[0], uv1[1]);
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 1;
        ctx.strokeRect(lx0, ly0, lx1 - lx0, ly1 - ly0);

        // --- Inset view: window uv -> inset rect, north up.
        const su = rect.w / (uv1[0] - uv0[0]);
        const sv = rect.h / (uv1[1] - uv0[1]);
        const insetView = {
            px: (u, v) => [rect.x + (u - uv0[0]) * su,
                           rect.y + rect.h - (v - uv0[1]) * sv],
            scale: rect.w / (win.x1 - win.x0),
            minPx: 1.6,
        };
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        // The close-up shows the full street grid the town is laid on.
        this._drawRoads(town, insetView, [0.9, 1.7, 2.6]);
        this._drawBuildings(town, insetView, colorOf, /*rings=*/true);
        ctx.restore();

        // Inset chrome: border + label.
        ctx.strokeStyle = "rgba(207,217,228,0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
        ctx.font = "10px system-ui, sans-serif";
        const label = "Town close-up";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(16,21,28,0.72)";
        ctx.fillRect(rect.x, rect.y, tw + 10, 15);
        ctx.fillStyle = "#dce3ec";
        ctx.fillText(label, rect.x + 5, rect.y + 11);
    }

    /** Draw the road network as lines, kind by kind (streets first so
     *  arterials render on top). `floors` = [street, shore, arterial]
     *  minimum line widths in css px for this view's zoom. */
    _drawRoads(town, view, floors) {
        const roads = town.roads;
        if (!roads || roads.edges.length === 0) return;
        const { ctx, grid } = this;
        // save/restore: canvas 2D state is persistent and this method runs
        // FIRST in render(), so leaking lineCap/lineJoin="round" (plus
        // strokeStyle and lineWidth) would silently round the corners of
        // the inset locator box, the inset border and every critical-
        // building ring drawn afterwards — chrome that was square before
        // roads existed.
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        // Edge indices bucketed by kind, and every node's uv, computed ONCE
        // per road graph instead of per frame: render() runs on every
        // animation frame and used to rescan all edges three times (two
        // thirds of that scan was a no-op `continue`) and recompute both
        // endpoints' uv for every edge, twice over — main map and inset.
        // The graph never mutates, so identity is a sound cache key.
        if (this._roadCacheFor !== roads || this._roadCacheGrid !== grid) {
            const byKind = [[], [], []];
            for (let e = 0; e < roads.edges.length; e++) {
                const k = roads.kind[e];
                if (byKind[k]) byKind[k].push(e);
            }
            const nU = new Float64Array(roads.nodes.length);
            const nV = new Float64Array(roads.nodes.length);
            for (let m = 0; m < roads.nodes.length; m++) {
                const q = uvOf(grid, roads.nodes[m][0], roads.nodes[m][1]);
                nU[m] = q.u;
                nV[m] = q.v;
            }
            this._roadCacheFor = roads;
            this._roadCacheGrid = grid;
            this._roadByKind = byKind;
            this._roadNodeU = nU;
            this._roadNodeV = nV;
        }
        const byKind = this._roadByKind;
        const nU = this._roadNodeU, nV = this._roadNodeV;
        for (const kind of [0, 1, 2]) {
            const list = byKind[kind];
            if (list.length === 0) continue;
            ctx.strokeStyle = ROAD_COLOR[kind];
            ctx.lineWidth = Math.max(floors[kind],
                                     ROAD_WIDTH_M[kind] * view.scale);
            ctx.beginPath();
            for (let q = 0; q < list.length; q++) {
                const [ui, vi] = roads.edges[list[q]];
                const [ax, ay] = view.px(nU[ui], nV[ui]);
                const [bx, by] = view.px(nU[vi], nV[vi]);
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawBuildings(town, view, colorOf, rings = false) {
        const { ctx, grid } = this;
        // Two passes: ordinary buildings first, critical on top (they are
        // the landmarks the damage/casualty story keys on).
        for (const critPass of [false, true]) {
            for (let k = 0; k < town.buildings.length; k++) {
                const b = town.buildings[k];
                if (b.type.critical !== critPass) continue;
                const { u, v } = uvOf(grid, b.x, b.y);
                const [cx, cy] = view.px(u, v);
                const s = Math.max(view.minPx, b.type.footprint_m * view.scale);
                ctx.fillStyle = (colorOf && colorOf(k, b)) || this._fillFor(b);
                ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
                if (rings && critPass) {
                    ctx.strokeStyle = "rgba(255,255,255,0.85)";
                    ctx.lineWidth = 1;
                    ctx.strokeRect(cx - s / 2 - 1.5, cy - s / 2 - 1.5,
                                   s + 3, s + 3);
                }
            }
        }
    }
}
