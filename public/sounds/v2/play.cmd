@echo off
rem Double-click to audition every sound; or: play.cmd tp
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0play.ps1" %*
pause
