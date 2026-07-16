"""
verify.py — smoke test: proves the app actually runs and responds ON THIS MACHINE.

A milestone is not done until this passes. It answers one question: if the
human double-clicks run.bat right now, do they see a working app?

How it works, in plain English:
 1. If the app is already running at URL, test it in place (and leave it running).
 2. Otherwise, start it with SERVER_COMMAND, wait for it to come up, test it,
    then shut it down.
 3. PASS  -> prints PASS, exit code 0.
    FAIL  -> prints the reason to stderr, exit code 2.
    (Exit 2 is what makes a Claude Code Stop hook treat this as blocking:
    Claude Code reads the stderr message and keeps working instead of stopping.)

This project is a STATIC SITE (WebGL2 tsunami simulator): the "server" is
Python's stdlib http.server on this project's dedicated port. The check here
proves the site is served and carries this app's identity marker; the physics
parity check needs a real GPU context and lives in the browser at
/parity.html (see BUILDLOG.md).
"""

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------- CONFIG (edit per project) ----------------
PORT = 5078                                    # MUST equal the port in run.bat
                                               # (5000/5050/5055/5057/5077 belong
                                               # to other projects on this machine)
SERVER_COMMAND = [sys.executable, "-m", "http.server", str(PORT),
                  "--directory", "site", "--bind", "127.0.0.1"]
APP_FILE = os.path.join("site", "index.html")  # if this doesn't exist yet, nothing to verify
URL = f"http://127.0.0.1:{PORT}/"              # the page a human would open
MUST_CONTAIN = [                               # strings that must appear in the response body
    "tsunami-web",                             # the app identity marker (meta tag)
    "Tsunami Simulator",                       # human-visible title
]
STARTUP_TIMEOUT_SECONDS = 20
# ------------------------------------------------------------


def fetch(url, timeout=5):
    """Return (status_code, body_text) or (None, error_message)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, str(e)


def check_response(status, body):
    """Return a list of failure reasons (empty list = pass)."""
    problems = []
    if status != 200:
        problems.append(f"Expected HTTP 200 from {URL}, got {status}.")
    for needle in MUST_CONTAIN:
        if needle not in body:
            problems.append(f"Response body is missing expected text: {needle!r}")
    return problems


def stop_process(proc):
    """Shut down the server we started (including children on Windows)."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
        )
    else:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    project_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(project_dir)

    # Nothing built yet? Then there's nothing to verify — don't block.
    if not os.path.exists(APP_FILE):
        print(f"verify.py: {APP_FILE} doesn't exist yet — nothing to verify. PASS (vacuous).")
        return 0

    # Case 1: already running (e.g. the human launched run.bat). Test in place.
    status, body = fetch(URL, timeout=3)
    started_here = None
    if status is None:
        # Case 2: not running. Start it ourselves.
        started_here = subprocess.Popen(
            SERVER_COMMAND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + STARTUP_TIMEOUT_SECONDS
        while time.time() < deadline:
            status, body = fetch(URL, timeout=3)
            if status is not None:
                break
            if started_here.poll() is not None:
                print(
                    f"FAIL: server process exited immediately (code {started_here.returncode}). "
                    f"Run it by hand to see the error: {' '.join(SERVER_COMMAND)}",
                    file=sys.stderr,
                )
                return 2
            time.sleep(0.5)

    try:
        if status is None:
            print(
                f"FAIL: nothing responded at {URL} within {STARTUP_TIMEOUT_SECONDS}s. "
                f"Last error: {body}",
                file=sys.stderr,
            )
            return 2

        problems = check_response(status, body)
        if problems:
            print("FAIL: " + " | ".join(problems), file=sys.stderr)
            return 2

        print(f"PASS: {URL} returned 200 and all {len(MUST_CONTAIN)} expected markers.")
        return 0
    finally:
        if started_here is not None:
            stop_process(started_here)


if __name__ == "__main__":
    sys.exit(main())
