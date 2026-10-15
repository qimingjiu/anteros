import asyncio
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from policy import (PolicyError, content_restricted, network_url, origin, public_ip, public_url, resolve_public, same_origin)
from gateway import PublicResolver


class UrlPolicyTests(unittest.TestCase):
    def test_rejects_internal_schemes_credentials_ports_and_obfuscated_ip(self):
        denied = ["http://localhost/a", "http://127.0.0.1/", "http://127.1/", "http://2130706433/",
                  "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/",
                  "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[ff02::1]/", "file:///etc/passwd",
                  "http://[64:ff9b::7f00:1]/", "http://[2606:4700:4700::1111%eth0]/",
                  "https://user:pass@example.com/", "https://example.com:8080/a", "http://router.lan/",
                  "https://example.com/%0d%0aAuthorization:test", "https://example.com\\@127.0.0.1/",
                  "https://example.com/?access_token=secret", "https://example.com/?api_key=secret",
                  "https://example.com/?X-Amz-Credential=secret", "https://example.com/?password=secret"]
        for value in denied:
            with self.subTest(value=value), self.assertRaises(PolicyError):
                public_url(value)

    def test_accepts_and_normalizes_public_urls(self):
        self.assertEqual(public_url("https://EXAMPLE.com:443/docs?q=term#part"), "https://example.com/docs?q=term")
        self.assertEqual(origin("https://example.com/a"), "https://example.com")
        self.assertEqual(same_origin("https://example.com/b", "https://example.com/a"), "https://example.com/b")
        self.assertTrue(public_ip("8.8.8.8"))
        self.assertFalse(public_ip("100.64.0.1"))
        with self.assertRaises(PolicyError):
            same_origin("https://cdn.example.com/a.js", "https://example.com/a")

    def test_restrictions_and_machine_use_directives(self):
        self.assertTrue(content_restricted({}, b'<html><title>Verify you are human</title></html>'))
        self.assertTrue(content_restricted({"x-robots-tag": "noai"}, b"article"))
        self.assertTrue(content_restricted({}, b'<meta name="robots" content="noarchive"><article>hello</article>'))
        self.assertFalse(content_restricted({}, b'<main><h1>Public document</h1><p>Text.</p></main>'))

    def test_spa_hash_kept_for_navigation_but_never_network_or_robots(self):
        for suffix in ("#/article/42", "#!/article/42"):
            url = "https://EXAMPLE.com:443/app" + suffix
            self.assertEqual(public_url(url), "https://example.com/app" + suffix)
            self.assertEqual(same_origin(url, "https://example.com/"), "https://example.com/app" + suffix)
            self.assertEqual(network_url(url), "https://example.com/app")
        self.assertEqual(public_url("https://example.com/app#heading"), "https://example.com/app")


class DnsTests(unittest.IsolatedAsyncioTestCase):
    async def test_mixed_public_and_private_dns_is_denied(self):
        rows = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("8.8.8.8", "127.0.0.1")]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=rows)):
            with self.assertRaises(PolicyError) as raised:
                await resolve_public("example.com", 443)
        self.assertEqual(raised.exception.reason, "dns_blocked")

    async def test_resolver_passes_validated_numeric_ip_to_connector(self):
        with patch("gateway.resolve_public", AsyncMock(return_value=["8.8.8.8"])):
            result = await PublicResolver().resolve("example.com", 443)
        self.assertEqual(result[0]["host"], "8.8.8.8")
        self.assertEqual(result[0]["flags"], socket.AI_NUMERICHOST)
        self.assertEqual(result[0]["hostname"], "example.com")


if __name__ == "__main__":
    unittest.main()
