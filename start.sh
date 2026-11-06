#!/usr/bin/env bash
# PIANO STUDIO · macOS / Linux 启动脚本
set -e
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python serve.py "$@"
else
  echo "  未找到 Python 3，请先安装：https://www.python.org/downloads/"
  exit 1
fi
