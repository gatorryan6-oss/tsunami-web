// Orbit camera for the 3D view — the JS port of the desktop
// render/camera.py. NOT physics: pure display.
//
// Project-wide coordinate convention (matches the desktop and the data):
//     x = east, y = north, z = up (elevation), meters, sea level = z 0.
//
// The camera is described by where it LOOKS (a target point on the ground)
// plus three numbers: compass angle around the target (yaw), tilt above
// the horizon (pitch), and distance. Mouse drags just change those
// numbers; the matrices are rebuilt from them every frame.

import { perspective, lookAt } from "./mat4.js";

const DEG = Math.PI / 180;
const EYE_HEIGHT_M = 2.0;        // human eye height for the beach view
const DEFAULT_FOV = 50.0;

export class OrbitCamera {
    constructor(target = [0, 0, 0], distance = 90_000.0,
                yawDeg = -120.0, pitchDeg = 35.0) {
        this._defaults = [target.slice(), distance, yawDeg, pitchDeg];
        this.fovYDeg = DEFAULT_FOV;
        this.far = 1_500_000.0;
        this.minDistance = 300.0;
        this.maxDistance = 500_000.0;
        this.minPitchDeg = 3.0;    // never quite reach the horizon...
        this.maxPitchDeg = 89.0;   // ...or straight overhead (both degenerate)
        // "beach" = a first-person camera standing on the shore looking out
        // to sea (eye fixed, yaw/pitch aim the gaze); "orbit" = the default
        // map-scale orbit. In beach mode waves render at 1x (real height),
        // set by the app, so the sea towers over you as it should.
        this.mode = "orbit";
        this.eye = [0, 0, 0];      // beach-mode eye position (world meters)
        this.beachMinPitchDeg = -35.0;   // look down at the water at your feet
        this.beachMaxPitchDeg = 60.0;    // ...up to the sky
        this.reset();
    }

    reset() {
        const [target, distance, yaw, pitch] = this._defaults;
        this.target = target.slice();
        this.distance = distance;
        this.yawDeg = yaw;
        this.pitchDeg = pitch;
        this.mode = "orbit";
        this.fovYDeg = DEFAULT_FOV;
    }

    /** Stand on the beach at (x, y) with the ground at groundZ, looking
     *  along lookYawDeg (world compass angle). The eye rises EYE_HEIGHT_M
     *  above the ground; the gaze starts level and mouse-look tilts it. */
    enterBeach(x, y, groundZ, lookYawDeg) {
        this.mode = "beach";
        this.eye = [x, y, groundZ + EYE_HEIGHT_M];
        this.yawDeg = lookYawDeg;
        this.pitchDeg = 0.0;       // level gaze at the horizon
        this.fovYDeg = 55.0;       // a touch wide for immersion
    }

    exitBeach() {
        this.mode = "orbit";
        this.fovYDeg = DEFAULT_FOV;
    }

    /** Unit gaze direction from yaw/pitch (beach mode). */
    _lookDir() {
        const yaw = this.yawDeg * DEG, pitch = this.pitchDeg * DEG;
        return [Math.cos(pitch) * Math.cos(yaw),
                Math.cos(pitch) * Math.sin(yaw),
                Math.sin(pitch)];
    }

    /** Aim at a world point from a given distance — used to snap the view
     *  onto the town so a small settlement on a big map is findable. */
    frame(target, distance, yawDeg = null, pitchDeg = null) {
        this.target = [target[0], target[1], target[2]];
        this.distance = Math.max(this.minDistance,
                                 Math.min(this.maxDistance, distance));
        if (yawDeg !== null) this.yawDeg = yawDeg;
        if (pitchDeg !== null) {
            this.pitchDeg = Math.max(this.minPitchDeg,
                                     Math.min(this.maxPitchDeg, pitchDeg));
        }
    }

    // The three mouse motions. dx/dy arrive in CSS pixels, +dy = cursor
    // moved DOWN the screen. Sign choices are taste (match the desktop).

    /** Left-drag: orbit the target, or (beach mode) turn the head — same
     *  gesture, so the control feels identical in both views. */
    orbit(dx, dy) {
        if (this.mode === "beach") {
            this.yawDeg -= dx * 0.15;    // drag right -> look right
            this.pitchDeg -= dy * 0.15;  // drag down -> look down
            this.pitchDeg = Math.max(this.beachMinPitchDeg,
                                     Math.min(this.beachMaxPitchDeg,
                                              this.pitchDeg));
            return;
        }
        this.yawDeg -= dx * 0.3;
        this.pitchDeg -= dy * 0.3;
        this.pitchDeg = Math.max(this.minPitchDeg,
                                 Math.min(this.maxPitchDeg, this.pitchDeg));
    }

    /** Right-drag: slide the target across the ground so the terrain
     *  follows the cursor. Speed scales with zoom. */
    pan(dx, dy) {
        const speed = this.distance * 0.0012;
        const yaw = this.yawDeg * DEG;
        // Camera right and ground-forward, flattened onto the ground plane.
        const rx = -Math.sin(yaw), ry = Math.cos(yaw);
        const fx = -Math.cos(yaw), fy = -Math.sin(yaw);
        this.target[0] -= rx * dx * speed;
        this.target[1] -= ry * dx * speed;
        this.target[0] += fx * dy * speed;
        this.target[1] += fy * dy * speed;
    }

    /** Keyboard/precise pan: slide the look-at point across the SEA-LEVEL
     *  plane along the view heading — `forward` toward the horizon, `right`
     *  sideways — in world meters. The target's height is untouched, so the
     *  motion is strictly parallel to sea level (fly out over the ocean,
     *  then zoom in on the blip). Amounts are world meters; the caller
     *  scales them by distance so a step feels the same at any zoom. */
    moveGround(forward, right) {
        const yaw = this.yawDeg * DEG;
        // Beach mode heads WHERE YOU LOOK (+forward toward the gaze); orbit
        // mode slides toward the horizon (-cos, -sin, the map convention).
        const s = this.mode === "beach" ? 1 : -1;
        const fx = s * Math.cos(yaw), fy = s * Math.sin(yaw);
        const rx = -Math.sin(yaw), ry = Math.cos(yaw);    // camera-right
        const p = this.mode === "beach" ? this.eye : this.target;
        p[0] += fx * forward + rx * right;
        p[1] += fy * forward + ry * right;
    }

    /** Scroll: dolly (orbit) or narrow the field of view like binoculars
     *  (beach — you can't walk on water, so "zoom" magnifies instead). */
    zoom(scrollY) {
        if (this.mode === "beach") {
            this.fovYDeg = Math.max(12.0,
                Math.min(70.0, this.fovYDeg * Math.pow(0.9, scrollY)));
            return;
        }
        this.distance *= Math.pow(0.9, scrollY);
        this.distance = Math.max(this.minDistance,
                                 Math.min(this.maxDistance, this.distance));
    }

    /** World-space camera position from yaw/pitch/distance (orbit), or the
     *  fixed eye (beach). */
    get position() {
        if (this.mode === "beach") return this.eye.slice();
        const yaw = this.yawDeg * DEG, pitch = this.pitchDeg * DEG;
        return [
            this.target[0] + Math.cos(pitch) * Math.cos(yaw) * this.distance,
            this.target[1] + Math.cos(pitch) * Math.sin(yaw) * this.distance,
            this.target[2] + Math.sin(pitch) * this.distance,
        ];
    }

    viewMatrix() {
        if (this.mode === "beach") {
            const e = this.eye, d = this._lookDir();
            return lookAt(e, [e[0] + d[0], e[1] + d[1], e[2] + d[2]],
                          [0, 0, 1]);
        }
        return lookAt(this.position, this.target, [0, 0, 1]);
    }

    projectionMatrix(aspect) {
        // Beach mode: the water is right at your feet, so the near plane
        // must be tight (a meter) — with the distance-based near below it
        // would clip the wave. Orbit mode: near slides with zoom, spending
        // depth precision on the near:far ratio (a fixed near either clips
        // the ground up close or z-fights terrain-vs-water when zoomed out).
        const near = this.mode === "beach"
            ? 1.0
            : Math.min(Math.max(this.distance * 0.02, 2.0), 2000.0);
        return perspective(this.fovYDeg, aspect, near, this.far);
    }
}
