"""Phira Web local static server.

Serves the `web` directory with correct MIME types (notably application/wasm)
and no-cache headers, then opens the default browser.

Usage: python serve.py [port]
"""
import http.server
import mimetypes
import os
import re
import socket
import socketserver
import sys
import urllib.error
import urllib.request
import webbrowser

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("font/otf", ".otf")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("text/javascript", ".js")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 明确告诉浏览器/下载管理器：这些资源是页面内联使用的，不是附件下载。
        # 这是防止 IDM 等工具拦截 .wasm/.ogg/.ttf 的关键。
        self.send_header("Content-Disposition", "inline")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def guess_type(self, path):
        # 确保 wasm / 音频 / 字体使用正确的 MIME，避免被当成 octet-stream 下载
        lower = path.lower()
        if lower.endswith(".wasm"):
            return "application/wasm"
        if lower.endswith(".ogg"):
            return "audio/ogg"
        if lower.endswith(".ttf"):
            return "font/ttf"
        if lower.endswith(".otf"):
            return "font/otf"
        return super().guess_type(path)

    def _serve_res(self, head_only):
        """无扩展名资源出口：/__res?p=assets/button.ogg

        下载管理器通常按 URL 扩展名 / MIME 判定是否拦截。这里用无扩展名路径
        并返回 text/plain + inline，让 IDM 等工具不再把游戏资源当文件下载。
        浏览器通过 XHR/fetch 拿到的仍是原始字节。
        """
        from urllib.parse import parse_qs, unquote, urlparse

        parsed = urlparse(self.path)
        if parsed.path != "/__res":
            return False

        rel = unquote(parse_qs(parsed.query).get("p", [""])[0]).lstrip("/")
        root = os.path.realpath(self.directory)
        full = os.path.realpath(os.path.join(root, rel))
        if not (full == root or full.startswith(root + os.sep)):
            self.send_error(403)
            return True
        if not os.path.isfile(full):
            self.send_error(404)
            return True

        with open(full, "rb") as f:
            data = f.read()

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)
        return True

    def do_GET(self):
        if self._serve_proxy(False):
            return
        if self._serve_res(False):
            return
        super().do_GET()

    def do_HEAD(self):
        if self._serve_proxy(True):
            return
        if self._serve_res(True):
            return
        super().do_HEAD()

    def do_POST(self):
        if self._serve_proxy(False):
            return
        self.send_error(405)

    def _serve_proxy(self, head_only):
        """同源代理，解决浏览器跨域（CORS）导致谱面预览/下载失败的问题。

        前端把跨域 http(s) 请求改写成 /__proxy?url=...，由本地服务器转发。
        """
        from urllib.parse import parse_qs, unquote, urlparse

        parsed = urlparse(self.path)
        if parsed.path != "/__proxy":
            return False

        target = unquote(parse_qs(parsed.query).get("url", [""])[0])
        if not re.match(r"^https?://", target, re.I):
            self.send_error(400, "invalid proxy url")
            return True

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        request = urllib.request.Request(target, data=body, method="HEAD" if head_only else self.command)
        for name in ("Authorization", "Accept", "Accept-Language", "Content-Type", "X-Requested-With", "If-Modified-Since", "If-None-Match"):
            value = self.headers.get(name)
            if value:
                request.add_header(name, value)
        # 不做压缩转发，避免客户端与浏览器重复解压
        request.add_header("Accept-Encoding", "identity")
        request.add_header("User-Agent", "PhiraWeb/1.0")

        # 需要原样转发的响应头（客户端依赖 Last-Modified 判断用户协议是否更新）
        skip_headers = {
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
            "content-encoding",
            "content-length",
            "content-type",
        }

        def relay_headers(headers):
            for name, value in headers.items():
                if name.lower() not in skip_headers:
                    self.send_header(name, value)

        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = b"" if head_only else response.read()
                self.send_response(response.status)
                relay_headers(response.headers)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
                self.send_header(
                    "Content-Length",
                    str(len(data)) if not head_only else response.headers.get("Content-Length", "0"),
                )
                self.end_headers()
                if not head_only:
                    self.wfile.write(data)
        except urllib.error.HTTPError as err:
            data = err.read() if not head_only else b""
            self.send_response(err.code)
            relay_headers(err.headers)
            self.send_header("Content-Type", err.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if not head_only:
                self.wfile.write(data)
        except Exception as err:  # noqa: BLE001
            self.send_error(502, str(err))
        return True

    def log_message(self, fmt, *args):
        pass


def find_port(preferred):
    candidates = [preferred] + [p for p in (8000, 8001, 8002, 8080, 8081) if p != preferred]
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.2)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free port found")


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    preferred = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    port = find_port(preferred)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"Phira Web: {url}")
        print("Press Ctrl+C to stop.")
        try:
            if os.environ.get("PHIRA_NO_BROWSER") != "1":
                webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("stopped")


if __name__ == "__main__":
    main()
