#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PIANO STUDIO 本地服务器

为什么需要它：Web Bluetooth 属于「强安全上下文」API，浏览器只允许在
https 或 http://localhost 下调用。直接双击 index.html（file:// 协议）
会被浏览器直接拒绝，连设备选择框都不会弹出来。

用法：
    python serve.py              自动选端口并打开浏览器
    python serve.py 9000         指定端口
    python serve.py --no-browser 只起服务
"""
import os
import socket
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFERRED_PORT = 8765


class Handler(SimpleHTTPRequestHandler):
    """静态文件服务，关掉缓存，避免改完页面看不到变化。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):  # 安静模式
        pass


def is_free(port):
    """探测端口是否可用。

    注意：这里刻意不设 SO_REUSEADDR —— 在 Windows 上它允许两个进程
    绑定同一个端口，会导致新服务「看起来起来了」，实际请求全被旧进程接走。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred, wanted=None):
    """优先用 wanted；否则从 preferred 往后找第一个空闲端口。"""
    if wanted and is_free(wanted):
        return wanted
    for port in range(preferred, preferred + 60):
        if is_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    args = [a for a in sys.argv[1:]]
    open_browser = "--no-browser" not in args
    port_arg = next((a for a in args if a.isdigit()), None)

    port = pick_port(PREFERRED_PORT, int(port_arg) if port_arg else None)
    url = "http://localhost:%d/" % port

    if port_arg and str(port) != port_arg:
        print("  [i] 端口 %s 已被占用，改用 %d。" % (port_arg, port))

    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("  [!] 当前目录下没有 index.html，请把 serve.py 放在项目根目录。")
        return 1

    print()
    print("  PIANO STUDIO  ·  电钢琴蓝牙录音工作台")
    print("  " + "-" * 46)
    print("  地址：%s" % url)
    print("  目录：%s" % ROOT)
    print()
    print("  必须用 Chrome 或 Edge 打开，蓝牙功能才能用。")
    print("  按 Ctrl+C 停止服务。")
    print()

    if open_browser:
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
