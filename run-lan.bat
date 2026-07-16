@echo off
rem Tsunami Simulator Web — serve on the LOCAL NETWORK (for Chromebooks /
rem classroom machines). Find this PC's address with `ipconfig` (IPv4) and
rem open http://THAT-ADDRESS:5078/ on the other device.
rem If Windows Firewall asks, allow Python on private networks.
cd /d "%~dp0"
echo Serving on this PC's network address, port 5078 ...
ipconfig | findstr /i "IPv4"
python -m http.server 5078 --directory site --bind 0.0.0.0
