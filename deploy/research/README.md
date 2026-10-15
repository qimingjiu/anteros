# Private research services

This directory deploys independently to `/opt/qq-bot-research`. It does not modify the existing QQ runtime deployment or its secrets, memories, login data, or databases. No paid API or third-party account key belongs in this stack.

## Services and boundaries

| Service | Host access | Purpose | Memory limit |
| --- | --- | --- | --- |
| SearXNG | `127.0.0.1:8888` | JSON link discovery | 512 MiB |
| sidecar | Internal network only | HTML extraction and constrained rendering | 1536 MiB, 256 MiB shared memory |
| gateway | `127.0.0.1:8787` | Public GET broker and fixed local extraction/render relay | 256 MiB |
| Valkey | No published port | Reserved SearXNG state store; no persistence | 128 MiB |

SearXNG initially enables only **MWMBL, Wikipedia, and arXiv** through their public, keyless API adapters. `keep_only` removes all other engines, so query parameters cannot activate an unapproved engine. MWMBL has a smaller index; Wikipedia and arXiv are specialized sources. This configuration does not promise general search coverage. A blocked provider is left blocked. The QQ runtime can supplement insufficient results with its separately budgeted configured search providers.

SearXNG's own interactive-browser bot detection is disabled (`server.limiter: false`) for this private loopback-only API: the QQ runtime enforces its query, request, host and time budgets. This fixes rejection of our legitimate server client by our own instance; it does not alter upstream site identity, IP addresses, user agents, access controls or rate limits. Do not publish this configuration as an unauthenticated public search service.

The browser is connected only to Docker's `internal` render network. It has no public default-route network. Every document, redirect, same-origin script and XHR is intercepted before navigation and **fulfilled with bounded bytes fetched by the gateway**. There is no route continuation, SOCKS/HTTP proxy, CONNECT tunnel, remote CDP port, stealth adapter, proxy rotation, cookie jar, session import, CAPTCHA solver, login, or paywall bypass. Crawl4AI 0.9.5 also adds an AutomationControlled-suppression launch argument independently of its stealth flag; the adapter explicitly removes that default argument and leaves normal automation identification enabled.

Only the gateway in the render stack has an Internet-capable network. It validates the URL, resolves every DNS answer, rejects mixed public/private answers, and gives the HTTP connector already-validated numeric addresses. This removes a separate hostname-resolution step at connection time. Both pre-checks and the actual connector reject private, loopback, link-local, reserved, multicast, transition/mapped IPv6, credential-bearing URLs, signed/token query parameters, and nonstandard ports. HTTPS certificates are verified.

The gateway allows only the initial **scheme + hostname + port**. Cross-origin redirects, CDN scripts, external API calls, frames, worker requests, WebSockets, non-GET methods and credentials are blocked. The fresh Playwright context has `service_workers="block"` before any page is created. Child pages are closed and their requests rejected. Purely visual same-origin image/font/media/CSS requests are omitted. Pages that depend on external scripts or authenticated APIs may therefore fail deliberately.

`check_robots_txt=True` remains enabled in Crawl4AI. Its `robots_parser.can_fetch` is adapted to the same gateway; it cannot make an uncontrolled direct request. The gateway applies robots rules to each actual URL and every redirect target. A successful empty file and known 404/410 absence are accepted; redirects, unreadable rules, HTML challenges, unknown errors and denied rules stop the render. Robots rules are held in memory for 5 minutes, at most 128 origins. Longest-match and wildcard matching use Protego. Crawl-delay and request-rate rules are honored, with at least one second between content requests per origin. If waiting exceeds the deadline, the render stops.

403/401/451, challenge markers and explicit `noai`/`noarchive`/`nosnippet` response/meta directives stop extraction. HTTP 429 is a separate terminal `rate_limited` failure with `retryAfterMs`: numeric seconds and HTTP-date `Retry-After` values create an origin cooldown shared across render sessions; missing/invalid values default to 60 seconds. During cooldown, robots and page attempts are rejected before any new network request. Live cooldown instructions are not evicted to make room for another origin. A successful robots check does not grant a copyright license or override terms: the runtime must still enforce known site restrictions, use bounded passages and attribution, and stop when a site's permission is uncertain. No article HTML is written to a persistent volume. Docker logging is disabled for these services; client errors contain only fixed safe reason strings.

Chromium runs as UID 10001 with the Chromium sandbox enabled. The seccomp profile is based on [Playwright's profile](https://raw.githubusercontent.com/microsoft/playwright/v1.64.0/utils/docker/seccomp_profile.json), with two compatibility changes: denied `clone3` returns `ENOSYS` so libc uses the filtered `clone` path, and `chroot` is permitted by seccomp so Chromium can complete its user-namespace sandbox. Kernel capability checks still apply; the outer container retains `cap_drop: ALL`. The configuration follows [Playwright's container guidance](https://playwright.dev/python/docs/docker). Do not add `--no-sandbox`, `SYS_ADMIN`, privileged mode, host networking, or a public browser endpoint.

Crawl4AI's pinned context setup injects a default `cookiesEnabled` cookie. The adapter clears cookies after setup and before initial navigation. Cookies or authorization added later remain prohibited. Playwright calls a route handler only for the first URL in an automatic redirect chain, so document redirects are aborted and explicitly navigated one hop at a time through the same gateway budget and robots checks. Cross-origin redirects stop; subresource redirects are conservatively rejected.

The gateway relays only fixed `/extract` and `/render` paths to `http://sidecar:8787`; caller input cannot change that service target. It strips incoming credentials and forwarding headers, refuses relay redirects, and bounds the request, response and deadline. The browser container itself publishes no host port and has no egress network. The private SearXNG instance disables its own browser bot-detection limiter for legitimate JSON API requests; runtime budgets still apply and upstream access restrictions remain unchanged.

## API

`POST /extract`:

```json
{"url":"https://public.example.org/article","html":"<article>...</article>","max_chars":20000}
```

This path reads only the supplied HTML. It uses trafilatura's Markdown extractor and title metadata; it does not download the URL or feed Markdown through another HTML extractor. HTML is limited to 2 MiB. The disposable child honors the caller's `timeout_ms`, capped at 8 seconds, instead of starting another fixed 8-second budget.

`POST /render`:

```json
{"url":"https://public.example.org/article","max_chars":20000,"timeout_ms":20000,"max_bytes":4194304,"max_requests":12}
```

`max_requests` includes **every gateway network attempt**, including robots retrieval and any redirect pre-checks, and cannot exceed 24. The requested value is honored when lower. The runtime currently reserves at most 12 attempts before calling this endpoint; it must not grant a second budget inside the sidecar. `max_bytes` is cumulative across all fetched bodies and cannot exceed 4 MiB; each body is limited to 2 MiB and robots to 256 KiB. Compression is not accepted, removing compressed-body expansion. A single render has at most 6 document navigations and a total deadline of at most 30 seconds. Responses are capped at 40,000 characters. One child process tree runs at a time; concurrent work gets `busy`.

The gateway's absolute deadline covers DNS resolution, HTTP connection, headers, body streaming and completion of empty bodies. An expired DNS operation cannot obtain a fresh minimum timeout and start a late HTTP request. SPA navigation fragments beginning with `#/` or `#!` are preserved for the browser and final URL; ordinary heading fragments are removed. HTTP and robots requests always strip fragments.

The service terminates the entire child process group after success, failure, deadline or cancellation, including Chromium grandchildren. Late child activity cannot continue after an abandoned call. A gateway session also has its own monotonic deadline.

Responses:

```json
{"status":"ok","title":"...","text":"Markdown body","finalUrl":"https://...","provider":"crawl4ai","extractor":"trafilatura","requestCount":3}
```

```json
{"status":"failed","title":"","text":"","finalUrl":"","provider":"crawl4ai","extractor":"crawl4ai","reason":"robots_denied","error":"The site does not allow this request under robots.txt.","requestCount":1}
```

`requestCount` is actual network attempts on successful or controlled-failure returns. Hard process timeouts can prevent recovery of this count, so that field is omitted then; the runtime keeps its full pre-reservation and does not refund unknown attempts. Pure extraction reports zero attempts.

Permission/safety reasons are terminal for that URL across all providers: `url_blocked`, `dns_blocked`, `cross_origin_blocked`, `robots_denied`, `robots_unavailable`, `site_restricted`, `redirect_blocked`, `rate_limited`. Do not send such a URL to a cloud fallback. Other fixed reasons are `size_limit`, `request_limit`, `deadline`, `unsupported_content`, `empty_content`, `busy`, `worker_failed`, `invalid_request`.

`GET /health` on the published gateway returns broker liveness. The sidecar's internal `/health` additionally verifies dependency versions. Neither returns endpoint configuration, secrets, URLs or article content. Dependency health alone does not prove Chromium rendering; run the actual-container smoke probe.

## Build and deployment

Only the supervising deployment flow should perform the SSH/copy/start steps. From `/opt/qq-bot-research` on the deployment host:

1. Copy `.env.example` to `.env`, generate a random local `SEARXNG_SECRET`, and set `.env` permissions to 0600. Do not use an existing service token.
2. Validate Compose locally: `docker compose config --quiet`. Avoid printing the expanded configuration because it includes the signing secret.
3. Build/pull without starting: `docker compose build --pull`, then `docker compose pull search valkey`.
4. Start: `docker compose up -d --wait`.
5. Verify actual listening sockets: SearXNG at `127.0.0.1:8888`, gateway at `127.0.0.1:8787`. Sidecar and Valkey must have no published host ports. Do not rely only on requested Compose port bindings.
6. Run the required actual-container checks: `docker compose exec -T sidecar python smoke_probe.py`. All checks must be true. This launches real Chromium against an in-memory fixture broker, validates successful extraction and same-origin redirects, rejects internal/cross-origin resources and redirects, tests blocked service workers and robots denial, and separately verifies a raw socket cannot reach a public address directly. Fixtures do not fetch live third-party pages.
7. Check search availability with a low-volume JSON request to `http://127.0.0.1:8888/search?q=moon&format=json`, inspect the responding engine names, and record sample size. Health alone does not prove MWMBL has useful results.
8. Before enabling the runtime's renderer, verify one explicitly permitted live public-page sample through the real gateway and the runtime. This deployment must not be described as fully verified solely from fixture tests.

Docker base images, SearXNG and Valkey have immutable manifest digests. The browser uses the official Playwright Python 1.63.0 Noble image, including matching browser binaries and system libraries. Direct Python dependencies are pinned to Crawl4AI 0.9.5, Playwright 1.63.0, trafilatura 2.3.1, aiohttp 3.14.5, and Protego 0.7.0; `constraints.txt` pins 110 transitive/direct packages resolved for Python 3.12/Linux. Crawl4AI's context setup, creation and robots adapters are version-specific; upgrades require repeating route/container tests.

## Local tests and current verification boundary

```text
python -m pip install -r sidecar/requirements-gateway.txt trafilatura==2.3.1
python -m unittest discover -s sidecar/tests -v
```

The policy/API suite uses real aiohttp, Protego and trafilatura and passes 48 tests, including DNS pinning/mixed answers, URL ambiguity/credentials, robots rules and unknown rules, challenges, explicit redirects, cumulative budgets, absolute DNS/empty-body deadlines, long Retry-After cooldowns, context cookies, table extraction, concurrency, fixed relay targets and bounded errors. These 48 tests also passed in the final deployment image on 2026-10-15. All nine actual-container smoke checks passed with sandboxed Chromium. A real public-page render through the published gateway returned Crawl4AI/trafilatura Markdown in three network attempts; a larger page stopped at its request budget. SearXNG's JSON API returned results. Keep these live/container checks separate from unit-test results and repeat them after upgrades.

## Official references checked for this implementation

- [Crawl4AI hooks](https://docs.crawl4ai.com/advanced/hooks-auth/), [parameters](https://docs.crawl4ai.com/api/parameters/).
- [Pinned browser manager source](https://github.com/unclecode/crawl4ai/blob/v0.9.5/crawl4ai/browser_manager.py), [crawler source](https://github.com/unclecode/crawl4ai/blob/v0.9.5/crawl4ai/async_webcrawler.py).
- [trafilatura Markdown and metadata](https://trafilatura.readthedocs.io/en/stable/quickstart.html).
- [SearXNG settings merge and keep_only](https://docs.searxng.org/admin/settings/settings.html#use-default-settings), [MWMBL adapter source](https://github.com/searxng/searxng/blob/b00212a8366131936856b726ed4dd9bd281e4d7e/searx/engines/mwmbl.py).
- [Playwright network interception](https://playwright.dev/python/docs/network), [container sandbox guidance](https://playwright.dev/python/docs/docker).
