#!/usr/bin/env python3
"""Static preview server with COOP/COEP headers for local WebAssembly testing.

The runtime is built with threads, so it needs SharedArrayBuffer, so the page
has to be cross-origin isolated. Serving dist/ through this makes
`crossOriginIsolated` true, which is the first thing the SDK checks.

The wasm binary is served in 20 MB pieces named `.wasm0`, `.wasm1`, …; those
extensions are mapped explicitly so the browser gets `application/wasm` for
them rather than a download.
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WASM_PIECES = {f".wasm{index}": "application/wasm" for index in range(10)}


class CoopCoepHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        **WASM_PIECES,
        ".wasm": "application/wasm",
        ".dll": "application/octet-stream",
        ".dat": "application/octet-stream",
    }

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve static files with COOP/COEP headers for local preview."
    )
    parser.add_argument("--port", type=int, default=8031, help="Port to bind to (default: 8031)")
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path("dist"),
        help="Directory to serve (default: dist)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    directory = args.directory.resolve()

    if not directory.is_dir():
        raise SystemExit(f"preview-server: directory does not exist: {directory}")

    handler = partial(CoopCoepHandler, directory=str(directory))
    server = ThreadingHTTPServer(("", args.port), handler)
    print(f"Serving {directory} at http://localhost:{args.port} (Ctrl+C to stop)")
    server.serve_forever()


if __name__ == "__main__":
    main()
