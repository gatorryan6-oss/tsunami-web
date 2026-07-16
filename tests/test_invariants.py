"""
tests/test_invariants.py — the architecture rules, as checks instead of prose.

Prose rules in a spec ("physics shaders are verbatim ports") stop working the
moment they fall out of Claude Code's context window. These tests don't.
Run with:  python -m pytest tests/test_invariants.py -q

This project is a WebGL2 static site, so the invariants guard JS/GLSL sources
with plain-text checks (stdlib only — no node needed to run them).

If one of these tests blocks what you're doing, the test is right until the
human says otherwise — ask, don't delete.
"""

import os
import re

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(PROJECT_ROOT, "site")
SHADERS = os.path.join(SITE, "shaders")
FROZEN = os.path.join(PROJECT_ROOT, "reference_shaders")

# The four physics shaders that must remain verbatim ports of the desktop
# originals (frozen at desktop commit 36adb05 in reference_shaders/).
PHYSICS_SHADERS = [
    "fullscreen.vert",
    "swe_hll_step.frag",
    "swe_max_acc.frag",
    "swe_hll_splat.frag",
]

# The ONLY allowed difference between a ported shader and its frozen desktop
# original: the desktop's `#version 330` first line is replaced by a header
# block delimited by these exact markers.
ES_HEADER_START = "// === ES 3.00 header"
ES_HEADER_END = "// === end ES header ==="

# Frozen physics constants: (file under site/, exact string that must appear).
FROZEN_CONSTANTS = [
    ("shaders/swe_hll_step.frag", "const float H_DRY = 1e-3;"),
    ("shaders/swe_hll_step.frag", "const float THETA = 1.3;"),
    ("shaders/swe_hll_step.frag", "const float WM_MIN_DEPTH = 1.0;"),
    ("shaders/swe_max_acc.frag", "const float H_DRY = 1e-3;"),
    ("shaders/swe_max_acc.frag", "const float ARRIVE_ANOMALY = 0.05;"),
    ("shaders/swe_hll_splat.frag", "const float SPLAT_MIN_DEPTH = 0.02;"),
    ("js/solver.js", "CFL_SAFETY = 0.35"),
    ("js/solver.js", "DT_MARGIN = 0.9"),
    ("js/solver.js", "REFRESH_EVERY = 30"),
    ("js/solver.js", "H_DRY = 1e-3"),
]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_es_header(text, name):
    """Remove the marked ES-3.00 header block from a ported shader.
    Returns the remainder, or fails the test if the markers are missing."""
    lines = text.splitlines()
    assert lines and lines[0].strip() == "#version 300 es", (
        f"{name}: ported shader must start with '#version 300 es'"
    )
    try:
        start = next(i for i, l in enumerate(lines) if l.startswith(ES_HEADER_START))
        end = next(i for i, l in enumerate(lines) if l.strip() == ES_HEADER_END)
    except StopIteration:
        pytest.fail(f"{name}: missing the marked ES header block "
                    f"({ES_HEADER_START!r} ... {ES_HEADER_END!r})")
    assert start < end, f"{name}: ES header markers out of order"
    remainder = lines[1:start] + lines[end + 1:]
    return "\n".join(l.rstrip() for l in remainder).strip()


def strip_desktop_header(text):
    """Remove the desktop original's `#version 330` first line."""
    lines = text.splitlines()
    assert lines[0].strip() == "#version 330"
    return "\n".join(l.rstrip() for l in lines[1:]).strip()


@pytest.mark.parametrize("name", PHYSICS_SHADERS)
def test_shader_is_verbatim_port(name):
    """Physics shaders match the frozen desktop originals line-for-line
    outside the marked ES header. 'Port it verbatim, not equivalently.'"""
    ported_path = os.path.join(SHADERS, name)
    if not os.path.exists(ported_path):
        pytest.skip(f"{name} not ported yet (M1).")
    ported = strip_es_header(read(ported_path), name)
    frozen = strip_desktop_header(read(os.path.join(FROZEN, name)))
    assert ported == frozen, (
        f"{name} diverges from reference_shaders/{name}. The ported physics "
        f"shaders must stay verbatim; improvements go to the DESKTOP repo "
        f"first, then re-freeze."
    )


@pytest.mark.parametrize("relpath,needle", FROZEN_CONSTANTS)
def test_frozen_constant(relpath, needle):
    path = os.path.join(SITE, relpath)
    if not os.path.exists(path):
        pytest.skip(f"{relpath} not written yet.")
    assert needle in read(path), (
        f"{relpath} lost the frozen constant {needle!r} — parity depends on "
        f"these matching the desktop exactly."
    )


def test_no_mediump_in_physics_shaders():
    """mediump anywhere in the physics path is a parity bug by definition."""
    if not os.path.isdir(SHADERS):
        pytest.skip("no shaders yet.")
    offenders = []
    for name in os.listdir(SHADERS):
        text = read(os.path.join(SHADERS, name))
        if name in PHYSICS_SHADERS and "mediump" in text:
            offenders.append(name)
    assert not offenders, f"mediump found in physics shaders: {offenders}"


def test_port_number_consistent():
    """run.bat, verify.py and CLAUDE.md must agree on this project's port."""
    for fname in ("run.bat", "verify.py", "CLAUDE.md"):
        text = read(os.path.join(PROJECT_ROOT, fname))
        assert "5078" in text, f"{fname} lost the project port 5078"
    # And verify.py must not have drifted to another project's port.
    vtext = read(os.path.join(PROJECT_ROOT, "verify.py"))
    m = re.search(r"^PORT = (\d+)", vtext, re.M)
    assert m and m.group(1) == "5078"


def test_hazard_accessor_boundary():
    """Everything downstream of physics consumes hazards through
    getHazardFields() (js/hazard.js). Only solver.js (the implementation)
    and hazard.js (the accessor) may touch the raw accumulator readbacks."""
    jsdir = os.path.join(SITE, "js")
    if not os.path.isdir(jsdir):
        pytest.skip("no js yet.")
    allowed = {"solver.js", "hazard.js"}
    violations = []
    for name in os.listdir(jsdir):
        if not name.endswith(".js") or name in allowed:
            continue
        text = read(os.path.join(jsdir, name))
        for needle in (".readHazards(", ".readMomentum("):
            if needle in text:
                violations.append(f"{name} calls {needle}")
    assert not violations, (
        "Hazard accessor boundary violated — route through getHazardFields():\n  "
        + "\n  ".join(violations)
    )
