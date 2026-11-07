@echo off
setlocal
title PIANO STUDIO - 本地服务（关闭本窗口即停止）
cd /d "%~dp0"

rem ================================================================
rem  重要：本文件必须保存为 GBK(cp936) 编码 + CRLF 换行。
rem  不要改成 UTF-8，也不要加 chcp 65001，更不要改成 LF：
rem  cmd.exe 读批处理时会按码页回读文件，UTF-8/中文/LF 三者
rem  同时出现会让它读偏字节，把 "%PY% serve.py" 截断成 "python"，
rem  于是双击后只弹出一个空的 Python 交互窗口（>>>），服务起不来。
rem ================================================================

if not exist "serve.py" (
  echo.
  echo   [错误] 这个文件夹里没有 serve.py。
  echo   请把 start.bat 和 serve.py 放在同一个文件夹里。
  echo.
  pause
  exit /b 1
)

rem ---- 找一个真能跑的 Python 3（微软商店的假 python.exe 会被挡掉）----
set "PY="

where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)

if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY=py -3"
  )
)

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

%PY% serve.py
pause
