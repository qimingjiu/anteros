"""Public-web rules shared by the only component allowed to reach the Internet."""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

USER_AGENT = "KoraxResearchBot/1.0 (+public-document-reading; respects robots.txt)"
MAX_BODY = 2 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024
MAX_REQUESTS = 24
MAX_DEADLINE_MS = 30_000
MAX_CHARS = 40_000
MAX_ROBOTS = 256 * 1024

ERRORS = {
    "invalid_request": "Invalid research request.",
    "url_blocked": "Only public HTTP and HTTPS URLs without credentials are allowed.",
    "dns_blocked": "The destination could not be verified as a public address.",
    "cross_origin_blocked": "Cross-origin browser requests are disabled.",
    "robots_denied": "The site does not allow this request under robots.txt.",
    "robots_unavailable": "The site rules could not be verified.",
    "site_restricted": "The site returned an access restriction or challenge.",
    "rate_limited": "The site requested a pause before further requests.",
    "http_error": "The public page returned an HTTP error.",
    "redirect_blocked": "The redirect does not satisfy the public-page policy.",
    "size_limit": "The research response exceeded its size limit.",
    "request_limit": "The render request budget was exhausted.",
    "deadline": "The research deadline was reached.",
    "unsupported_content": "This response format is not supported.",
    "empty_content": "No usable main content was extracted.",
    "busy": "The research worker is already in use.",
    "worker_failed": "The research worker could not complete the request.",
}


class PolicyError(Exception):
    def __init__(self, reason: str):
        self.reason = reason if reason in ERRORS else "worker_failed"
        super().__init__(ERRORS[self.reason])


def public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
        if address.version == 6 and (address.ipv4_mapped or address.sixtofour or address.teredo):
            return False
        if address.version == 6 and (address in ipaddress.ip_network("64:ff9b::/96") or address in ipaddress.ip_network("64:ff9b:1::/48")):
            return False
        return address.is_global and not (address.is_multicast or address.is_reserved or address.is_unspecified)
    except ValueError:
        return False


def public_url(value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        raise PolicyError("url_blocked")
    if re.search(r"[\x00-\x20\x7f\\]", value) or re.search(r"[\x00-\x1f\x7f\\]", unquote(value)):
        raise PolicyError("url_blocked")
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError()
        if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
            raise ValueError()
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if "%" in host:
            raise ValueError()
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        if port not in {80, 443} or (parsed.scheme == "https" and port != 443) or (parsed.scheme == "http" and port != 80):
            raise ValueError()
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home", ".lan", ".invalid", ".test")):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or "." not in host or ".." in host:
                raise ValueError()
            # Browser and libc legacy IPv4 notations must never become public hostnames.
            if all(re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)", part) for part in host.split(".")):
                raise ValueError()
        else:
            if not public_ip(host):
                raise ValueError()
        for key, _ in parse_qsl(parsed.query, keep_blank_values=True):
            if re.search(r"(?:^|[_-])(?:auth|authorization|token|password|passwd|secret|signature|sig|credential|api[_-]?key|key|session|sessionid|jwt)(?:$|[_-])", key, re.I) or key.lower().startswith("x-amz-"):
                raise ValueError()
        authority = f"[{host}]" if ":" in host else host
        fragment = parsed.fragment if parsed.fragment.startswith(("/", "!")) else ""
        return urlunsplit((parsed.scheme.lower(), authority, parsed.path or "/", parsed.query, fragment))
    except (ValueError, UnicodeError):
        raise PolicyError("url_blocked") from None


def origin(value: str) -> str:
    parsed = urlsplit(public_url(value))
    return f"{parsed.scheme}://{parsed.netloc}"


def network_url(value: str) -> str:
    """SPA hashes are navigation state; HTTP and robots only receive path and query."""
    parsed = urlsplit(public_url(value))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def same_origin(value: str, initial: str) -> str:
    normalized = public_url(value)
    if origin(normalized) != origin(initial):
        raise PolicyError("cross_origin_blocked")
    return normalized


async def resolve_public(host: str, port: int) -> list[str]:
    try:
        rows = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM), 4
        )
        addresses = list(dict.fromkeys(row[4][0] for row in rows))
        if not addresses or len(addresses) > 32 or any(not public_ip(address) for address in addresses):
            raise PolicyError("dns_blocked")
        return addresses
    except (OSError, asyncio.TimeoutError):
        raise PolicyError("dns_blocked") from None


def content_restricted(headers: dict[str, str], body: bytes) -> bool:
    directives = headers.get("x-robots-tag", "").lower()
    if any(value in directives for value in ("nosnippet", "noarchive", "noai")):
        return True
    sample = body[:131072].decode("utf-8", "ignore").lower()
    challenge_patterns = (
        "cf-chl-", "challenge-platform", "g-recaptcha", "h-captcha", "hcaptcha.com/1/api.js",
        "verify you are human", "checking your browser", "enable javascript and cookies to continue",
        "captcha-container", 'id="captcha"', "access to this page has been denied", "perimeterx",
    )
    if any(value in sample for value in challenge_patterns):
        return True
    for meta in re.findall(r"<meta\b[^>]*>", sample):
        if re.search(r"\bname\s*=\s*['\"]?(?:robots|[a-z]+bot)\b", meta) and any(value in meta for value in ("nosnippet", "noarchive", "noai")):
            return True
    return False


def bounded_integer(value: object, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    if type(value) is not int or value < minimum:
        raise PolicyError("invalid_request")
    return min(value, maximum)


def failed(reason: str, provider: str = "crawl4ai") -> dict:
    reason = reason if reason in ERRORS else "worker_failed"
    return {"status": "failed", "title": "", "text": "", "finalUrl": "", "provider": provider,
            "extractor": "trafilatura" if provider == "trafilatura" else "crawl4ai",
            "reason": reason, "error": ERRORS[reason]}
