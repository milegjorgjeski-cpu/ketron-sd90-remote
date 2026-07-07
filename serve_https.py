"""
serve_https.py
Serves web_app/ over HTTPS with a self-signed certificate, so a phone on the
same Wi-Fi/LAN can load the PWA and use Web Bluetooth (which requires a
"secure context" — HTTPS, or localhost).

Generates certs/cert.pem + certs/key.pem on first run (reused after that).
Your phone's browser will show a certificate warning on first visit — that's
expected for a self-signed cert; tap "Advanced" / "Proceed anyway".

Usage:
    python serve_https.py [port]        # default port 8443

Then on your phone (same Wi-Fi), open:
    https://<this-pc's-LAN-IP>:8443/
"""

import http.server
import os
import socket
import ssl
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(DIR, "certs")
CERT_PATH = os.path.join(CERT_DIR, "cert.pem")
KEY_PATH = os.path.join(CERT_DIR, "key.pem")


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert():
    if os.path.isfile(CERT_PATH) and os.path.isfile(KEY_PATH):
        return
    os.makedirs(CERT_DIR, exist_ok=True)

    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sd90-remote.local")])
    ip = lan_ip()

    san_names = [x509.DNSName("localhost")]
    for addr in {ip, "127.0.0.1"}:
        try:
            san_names.append(x509.IPAddress(ipaddress.ip_address(addr)))
        except ValueError:
            pass

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_names), critical=False)
        .sign(key, hashes.SHA256())
    )

    with open(KEY_PATH, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(CERT_PATH, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print(f"Generated self-signed cert for localhost / {ip} -> {CERT_DIR}")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    ensure_cert()
    os.chdir(DIR)

    handler = http.server.SimpleHTTPRequestHandler
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT_PATH, keyfile=KEY_PATH)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    ip = lan_ip()
    print(f"Serving {DIR}")
    print(f"  Local:   https://localhost:{port}/")
    print(f"  Network: https://{ip}:{port}/   <- open this on your phone")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
