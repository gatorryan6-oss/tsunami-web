// Town data: the frozen building list baked by the DESKTOP generator
// (port_package/make_town_data.py, seed 1) on the shared scenario bed —
// data-not-code, the same philosophy as terrain and Okada. The three
// reference scenarios share one bit-identical bed (verified at bake time),
// so ONE town serves all three; the damage/casualty milestones assess
// exactly these buildings, and the desktop can compute canonical expected
// numbers on the identical (cm-rounded) coordinates for the contract tests.
//
// This module is data + accessors only. No GL, no hazard reads.

export class Town {
    constructor(buildings, types, provenance, summary, roads = null) {
        this.buildings = buildings;   // [{t, x, y, gz, h, rot, type}]
        this.types = types;           // name -> type record (value_usd, ...)
        this.provenance = provenance;
        this.baked = summary;         // the bake-time summary block
        // The road graph (M12c): {nodes: [[x,y],...], edges: [[u,v],...],
        // kind: [k,...]} or null (a pre-roads town.json). The evacuation
        // model (M12b) routes over this; the overlay/3D views draw it.
        this.roads = roads;
    }

    /** Census population — people sleep where they live (night occupancy). */
    get population() {
        return this.buildings.reduce(
            (s, b) => s + b.type.occupancy_night, 0);
    }

    peoplePresent(daytime) {
        return this.buildings.reduce(
            (s, b) => s + (daytime ? b.type.occupancy_day
                                   : b.type.occupancy_night), 0);
    }

    get totalValue() {
        return this.buildings.reduce((s, b) => s + b.type.value_usd, 0);
    }

    get criticalCount() {
        return this.buildings.reduce(
            (s, b) => s + (b.type.critical ? 1 : 0), 0);
    }

    summary() {
        return `${this.buildings.length} buildings ` +
               `(${this.criticalCount} critical) · ` +
               `population ${this.population.toLocaleString("en-US")} · ` +
               `value $${(this.totalValue / 1e9).toFixed(2)}B`;
    }

    /** {cx, cy, r} of the built-up core: MEDIAN center + 90th-percentile
     *  radius — robust to the far-flung rural homes, so a view framed on
     *  this sees the town, not an empty box stretched to outliers
     *  (mirror of the desktop Town.footprint()). */
    footprint() {
        const xs = this.buildings.map(b => b.x).sort((a, b) => a - b);
        const ys = this.buildings.map(b => b.y).sort((a, b) => a - b);
        const med = (arr) => arr[(arr.length - 1) >> 1];
        const cx = med(xs), cy = med(ys);
        const d = this.buildings
            .map(b => Math.hypot(b.x - cx, b.y - cy))
            .sort((a, b) => a - b);
        const r = d[Math.min(d.length - 1, Math.floor(0.90 * d.length))];
        return { cx, cy, r };
    }
}

/** Fetch + validate town.json. Every check here fails LOUD: a truncated
 *  download or a type that doesn't resolve would otherwise surface later
 *  as silently-wrong damage numbers. */
export async function loadTown(url = "data/town.json") {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
    }
    const raw = await resp.json();
    if (raw.format !== 1) {
        throw new Error(`${url}: unknown town format ${raw.format}`);
    }
    const types = raw.types;
    const buildings = raw.buildings.map((b, k) => {
        const type = types[b.t];
        if (!type) {
            throw new Error(`${url}: building ${k} has unknown type "${b.t}"`);
        }
        for (const key of ["x", "y", "gz", "h"]) {
            if (!Number.isFinite(b[key])) {
                throw new Error(`${url}: building ${k} has non-finite ${key}`);
            }
        }
        return { ...b, type };
    });
    // The road graph, validated LOUD like the buildings: a truncated
    // download or an edge indexing a nonexistent node would otherwise
    // surface later as a silently-wrong evacuation route. A town.json
    // without roads (pre-M12c) loads roads=null and the evacuation model
    // falls back to the legacy beeline.
    let roads = null;
    if (raw.roads) {
        const rr = raw.roads;
        const nNodes = rr.nodes.length;
        for (let k = 0; k < nNodes; k++) {
            if (!Number.isFinite(rr.nodes[k][0]) ||
                !Number.isFinite(rr.nodes[k][1])) {
                throw new Error(`${url}: road node ${k} is non-finite`);
            }
        }
        if (rr.edges.length !== rr.kind.length) {
            throw new Error(`${url}: ${rr.edges.length} road edges but ` +
                            `${rr.kind.length} kinds — corrupt data`);
        }
        for (let k = 0; k < rr.edges.length; k++) {
            const [u, v] = rr.edges[k];
            if (u < 0 || v < 0 || u >= nNodes || v >= nNodes || u === v) {
                throw new Error(`${url}: road edge ${k} [${u},${v}] is ` +
                                `out of range or a self-loop`);
            }
            // Zero-length edges divide by zero in the router's segment
            // projection, and desktop/browser recover from the NaN in
            // OPPOSITE directions — one would silently reroute the whole
            // town here only. Mirrors the desktop's _validate_roads.
            const ddx = rr.nodes[v][0] - rr.nodes[u][0];
            const ddy = rr.nodes[v][1] - rr.nodes[u][1];
            if (!(ddx * ddx + ddy * ddy > 0.0)) {
                throw new Error(`${url}: road edge ${k} has zero length`);
            }
            // An unknown kind indexes past the renderers' width/color
            // tables and kills the 3D scene with an opaque TypeError.
            if (rr.kind[k] !== 0 && rr.kind[k] !== 1 && rr.kind[k] !== 2) {
                throw new Error(`${url}: road edge ${k} has unknown kind ` +
                                `${rr.kind[k]}`);
            }
        }
        // Corruption tripwire against the bake-time summary, the same way
        // the building count is checked below.
        const s0 = raw.summary || {};
        if (s0.road_nodes !== undefined &&
            (s0.road_nodes !== nNodes || s0.road_edges !== rr.edges.length)) {
            throw new Error(`${url}: road graph is ${nNodes} nodes / ` +
                            `${rr.edges.length} edges but the bake recorded ` +
                            `${s0.road_nodes}/${s0.road_edges} — truncated?`);
        }
        roads = { nodes: rr.nodes, edges: rr.edges, kind: rr.kind };
    }
    const town = new Town(buildings, types, raw.provenance, raw.summary,
                          roads);
    // Internal consistency vs the bake-time summary — corruption tripwire.
    const s = raw.summary;
    if (buildings.length !== s.buildings) {
        throw new Error(`${url}: ${buildings.length} buildings but the bake ` +
                        `recorded ${s.buildings} — truncated download?`);
    }
    if (town.population !== s.population_night ||
        town.totalValue !== s.total_value_usd) {
        throw new Error(`${url}: recomputed population/value disagree with ` +
                        `the bake-time summary — corrupt data`);
    }
    return town;
}
