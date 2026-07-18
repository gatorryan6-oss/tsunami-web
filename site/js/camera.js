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

export class OrbitCamera {
    constructor(target = [0, 0, 0], distance = 90_000.0,
                yawDeg = -120.0, pitchDeg = 35.0) {
        this._defaults = [target.slice(), distance, yawDeg, pitchDeg];
        this.fovYDeg = 50.0;
        this.far = 1_500_000.0;
        this.minDistance = 300.0;
        this.maxDistance = 500_000.0;
        this.minPitchDeg = 3.0;    // never quite reach the horizon...
        this.maxPitchDeg = 89.0;   // ...or straight overhead (both degenerate)
        this.reset();
    }

    reset() {
        const [target, distance, yaw, pitch] = this._defaults;
        this.target = target.slice();
        this.distance = distance;
        this.yawDeg = yaw;
        this.pitchDeg = pitch;
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

    /** Left-drag: fly around the target. */
    orbit(dx, dy) {
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
        const fx = -Math.cos(yaw), fy = -Math.sin(yaw);   // toward the horizon
        const rx = -Math.sin(yaw), ry = Math.cos(yaw);    // camera-right
        this.target[0] += fx * forward + rx * right;
        this.target[1] += fy * forward + ry * right;
    }

    /** Scroll: move closer/farther. Multiplicative, so one notch feels the
     *  same whether 1 km out or 100 km out. scrollY > 0 = zoom in. */
    zoom(scrollY) {
        this.distance *= Math.pow(0.9, scrollY);
        this.distance = Math.max(this.minDistance,
                                 Math.min(this.maxDistance, this.distance));
    }

    /** World-space camera position from yaw/pitch/distance. */
    get position() {
        const yaw = this.yawDeg * DEG, pitch = this.pitchDeg * DEG;
        return [
            this.target[0] + Math.cos(pitch) * Math.cos(yaw) * this.distance,
            this.target[1] + Math.cos(pitch) * Math.sin(yaw) * this.distance,
            this.target[2] + Math.sin(pitch) * this.distance,
        ];
    }

    viewMatrix() {
        return lookAt(this.position, this.target, [0, 0, 1]);
    }

    projectionMatrix(aspect) {
        // The near plane slides with zoom: depth precision is spent on the
        // near:far ratio, so a fixed near either clips the ground up close
        // or z-fights terrain-vs-water at the shoreline when zoomed out.
        const near = Math.min(Math.max(this.distance * 0.02, 2.0), 2000.0);
        return perspective(this.fovYDeg, aspect, near, this.far);
    }
}
