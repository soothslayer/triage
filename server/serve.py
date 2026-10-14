"""HTTPS server for the Triage Quest test app (port 4443).

Serves ../dist statically. WebXR requires a secure context, so this wraps
the plain http.server in TLS with a self-signed cert (the Quest browser
needs the one-time certificate warning bypass, same as the Quest voice app).

Kept in the repo (not /tmp) so it survives reboots and /tmp cleanups.
Restart: pkill -f 'triage/server/serve.py', then relaunch with nohup.
Never delete ../dist while this server is running: its working directory is
the dist dir, and deleting it leaves the process wedged on a vanished CWD.
"""

import http.server
import os
import ssl

PORT = 4443
HERE = os.path.dirname(os.path.abspath(__file__))

os.chdir(os.path.join(HERE, "..", "dist"))
srv = http.server.HTTPServer(("0.0.0.0", PORT), http.server.SimpleHTTPRequestHandler)
srv.socket = ssl.wrap_socket(
    srv.socket,
    keyfile=os.path.join(HERE, "triage-key.pem"),
    certfile=os.path.join(HERE, "triage-cert.pem"),
    server_side=True,
)
print(f"serving ../dist on https://0.0.0.0:{PORT}", flush=True)
srv.serve_forever()
