@echo off
rem Tsunami Simulator Web — serve the static site on this project's port (5078)
rem then open http://127.0.0.1:5078/ in a browser.
cd /d "%~dp0"
start "" http://127.0.0.1:5078/
python -m http.server 5078 --directory site --bind 127.0.0.1
