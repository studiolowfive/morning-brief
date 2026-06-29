@echo off
REM Launcher for the scheduled Morning Brief daily run.
REM cd to this script's folder (project root), run the daily pipeline, log output.
cd /d "%~dp0"
node src\cli.js daily >> logs\scheduler.log 2>&1
