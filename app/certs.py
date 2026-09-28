"""Самоподписанный HTTPS для локальной сети.

Свой корневой сертификат (CA) + листовой для сервера. CA ставится на iPhone один раз
(скачать /ca.crt → Настройки → Профиль загружен → Установить → Основные → Об этом
устройстве → Доверие сертификатам). Листовой перевыпускается сам, когда у Mac появляется
новый IP; CA не меняется никогда — иначе пришлось бы переустанавливать его на всех устройствах.

Сертификаты через `cryptography`, не через openssl: системный openssl в macOS — LibreSSL
без `-addext`. Для iOS листовой сертификат должен жить ≤ 825 дней и иметь EKU serverAuth.
"""
import datetime as dt
import ipaddress
import json
import re
import socket
import subprocess
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from .db import DATA_DIR

CA_CERT = DATA_DIR / "ca.pem"
CA_KEY = DATA_DIR / "ca.key"
CERT = DATA_DIR / "server.pem"
KEY = DATA_DIR / "server.key"
NAMES = DATA_DIR / "server_names.json"


def local_ips() -> list[str]:
    ips = set()
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=3).stdout
        ips.update(re.findall(r"inet (\d+\.\d+\.\d+\.\d+)", out))
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    ips.discard("127.0.0.1")
    return sorted(i for i in ips if not i.startswith("169.254."))


_host_cache: tuple[float, str | None] = (0, None)


def mdns_name() -> str | None:
    """Имя Mac в локальной сети: `<LocalHostName>.local`. Кэш 5 минут — внутри subprocess."""
    global _host_cache
    if time.time() - _host_cache[0] < 300:
        return _host_cache[1]
    name = None
    try:
        out = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3)
        if out.returncode == 0 and out.stdout.strip():
            name = out.stdout.strip() + ".local"
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not name:
        h = socket.gethostname().split(".")[0]
        name = f"{h}.local" if h else None
    _host_cache = (time.time(), name)
    return name


def _write_key(path, key) -> None:
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    path.chmod(0o600)


def _ensure_ca():
    if CA_CERT.exists() and CA_KEY.exists():
        return (x509.load_pem_x509_certificate(CA_CERT.read_bytes()),
                serialization.load_pem_private_key(CA_KEY.read_bytes(), None))
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Trainer local CA"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Trainer")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                         content_commitment=False, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CA_CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _write_key(CA_KEY, key)
    return cert, key


def wanted_names() -> dict:
    dns = ["localhost"]
    if mdns_name():
        dns.append(mdns_name())
    ips = ["127.0.0.1", *local_ips()]
    # внешний адрес статического режима WAN — тоже в сертификат (подхватится при перезапуске)
    from . import wan
    if (h := wan.static_host()):
        try:
            ipaddress.ip_address(h)
            ips.append(h)
        except ValueError:
            dns.append(h)
    return {"dns": dns, "ips": ips}


def ensure() -> tuple[str, str]:
    """Вернуть (cert, key) для uvicorn; перевыпустить листовой, если сменились адреса или истекает срок."""
    ca_cert, ca_key = _ensure_ca()
    want = wanted_names()
    if CERT.exists() and KEY.exists() and NAMES.exists():
        have = json.loads(NAMES.read_text())
        cert = x509.load_pem_x509_certificate(CERT.read_bytes())
        fresh = cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc) > dt.timedelta(days=30)
        if fresh and set(want["dns"]) <= set(have["dns"]) and set(want["ips"]) <= set(have["ips"]):
            return str(CERT), str(KEY)
        # старые адреса оставляем: PWA, установленная по прежнему IP, не должна потерять доверие
        want = {"dns": sorted(set(want["dns"]) | set(have["dns"])), "ips": sorted(set(want["ips"]) | set(have["ips"]))}

    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    san = [x509.DNSName(d) for d in want["dns"]] + [x509.IPAddress(ipaddress.ip_address(i)) for i in want["ips"]]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, want["dns"][-1])]))
            .issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=800))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, key_cert_sign=False,
                                         crl_sign=False, content_commitment=False, data_encipherment=False,
                                         key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _write_key(KEY, key)
    NAMES.write_text(json.dumps(want))
    return str(CERT), str(KEY)


def ca_der() -> bytes:
    return x509.load_pem_x509_certificate(CA_CERT.read_bytes()).public_bytes(serialization.Encoding.DER)
