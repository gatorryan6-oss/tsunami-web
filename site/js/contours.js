// Iso-contours of a scalar grid field (marching squares) — display only,
// NOT physics. M13b uses this to draw depth contours over the ocean (the
// bathymetry — bay, ridge, shelf break — is invisible in the flat 2D
// colormap without them) and the 15 m refuge line on land.
//
// Output is a flat Float64Array of world-coordinate segments
// [x0,y0, x1,y1, ...]: the overlay strokes them through its own
// view transforms. Segments are left unjoined — canvas doesn't care,
// and joining adds code for zero visual gain at 1-2 px line widths.
//
// Grid convention (repo rule): field is row-major with j = 0 the SOUTH
// row; cell (i, j) has corners at world (xmin + i*dx, ymin + j*dx).

/** March one level. `field` is Float32Array(n*n); returns segments in
 *  world meters. */
export function contourSegments(field, n, dx, xmin, ymin, level) {
    const out = [];
    // Interpolated crossing point along an edge between corner values
    // a (at t=0) and b (at t=1).
    const t = (a, b) => (level - a) / (b - a);
    for (let j = 0; j < n - 1; j++) {
        const r0 = j * n, r1 = (j + 1) * n;
        const y0 = ymin + j * dx;
        for (let i = 0; i < n - 1; i++) {
            const f00 = field[r0 + i], f10 = field[r0 + i + 1];
            const f01 = field[r1 + i], f11 = field[r1 + i + 1];
            let idx = 0;
            if (f00 > level) idx |= 1;
            if (f10 > level) idx |= 2;
            if (f11 > level) idx |= 4;
            if (f01 > level) idx |= 8;
            if (idx === 0 || idx === 15) continue;
            const x0 = xmin + i * dx;
            // Edge crossing points (only computed when used):
            // S: bottom (f00-f10), E: right (f10-f11),
            // N: top (f01-f11), W: left (f00-f01).
            const S = () => [x0 + t(f00, f10) * dx, y0];
            const E = () => [x0 + dx, y0 + t(f10, f11) * dx];
            const N = () => [x0 + t(f01, f11) * dx, y0 + dx];
            const W = () => [x0, y0 + t(f00, f01) * dx];
            let segs;
            switch (idx) {
                case 1: case 14: segs = [W(), S()]; break;
                case 2: case 13: segs = [S(), E()]; break;
                case 3: case 12: segs = [W(), E()]; break;
                case 4: case 11: segs = [E(), N()]; break;
                case 6: case 9:  segs = [S(), N()]; break;
                case 7: case 8:  segs = [W(), N()]; break;
                case 5: case 10: {
                    // Saddle: split by the cell-center average.
                    const mid = 0.25 * (f00 + f10 + f01 + f11);
                    const hi = (idx === 5) === (mid > level);
                    segs = hi ? [W(), N(), S(), E()] : [W(), S(), N(), E()];
                    break;
                }
                default: continue;
            }
            for (let s = 0; s + 1 < segs.length; s += 2) {
                out.push(segs[s][0], segs[s][1],
                         segs[s + 1][0], segs[s + 1][1]);
            }
        }
    }
    return new Float64Array(out);
}
