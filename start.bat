@echo off
chcp 65001 >nul
title PIANO STUDIO - 本地服务（关闭本窗口即停止）
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"

if not defined PY (
  echo.
  echo   [错误] 没有找到 Python 3。
  echo.
  echo   请到 https://www.python.org/downloads/ 下载安装，
  echo   安装第一步记得勾选 "Add python.exe to PATH"。
  echo.
  pause
  exit /b 1
)

echo.
echo   PIANO STUDIO  -  电钢琴蓝牙录音工作台
echo   --------------------------------------------------
echo   浏览器会自动打开。没打开就手动访问：
echo   http://localhost:8765/
echo.
echo   必须用 Chrome 或 Edge，蓝牙功能才能用。
echo   关闭这个窗口 = 停止服务。
echo.

%PY% serve.py
pause
