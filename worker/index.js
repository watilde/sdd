/**
 * SDD CORS Proxy — Cloudflare Worker
 *
 * Usage:
 *   GET https://<worker-url>/?url=https://example.com
 *
 * - Fetches the target URL via Browserless.io (full JS rendering)
 * - Falls back to direct fetch if Browserless fails
 * - Returns rendered HTML with permissive CORS headers
 * - Blocks private/loopback IPs to prevent SSRF
 *
 * Environment variables (set as Worker secrets):
 *   BROWSERLESS_TOKEN — API token for browserless.io
 */

const ALLOWED_SCHEMES = ['http:', 'https:'];

// SSRF対策: プライベートIP帯をブロック
const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function isPrivateHost(hostname) {
  return PRIVATE_PATTERNS.some(p => p.test(hostname));
}

/**
 * Fetch with full JS rendering via Browserless.io /content endpoint
 * Returns rendered HTML string or throws on error
 */
async function fetchWithBrowserless(url, token) {
  const endpoint = `https://production-sfo.browserless.io/content?token=${token}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      waitForTimeout: 3000,        // wait up to 3s for JS to settle
      bestAttempt: true,           // return partial result instead of failing
      gotoOptions: {
        waitUntil: 'networkidle2', // wait until network is quiet
        timeout: 15000,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Browserless ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.text();
}

/**
 * Fallback: plain HTTP fetch (no JS rendering)
 */
async function fetchDirect(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SDD-Proxy/1.0; +https://github.com/watilde/sdd)',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en,ja;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405, headers: CORS_HEADERS,
      });
    }

    // ?url= パラメータを取得
    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // URLバリデーション
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return new Response(JSON.stringify({ error: 'Only http/https allowed' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (isPrivateHost(parsed.hostname)) {
      return new Response(JSON.stringify({ error: 'Private/loopback addresses not allowed' }), {
        status: 403,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Browserless トークン (Worker secret か埋め込み値)
    const token = env.BROWSERLESS_TOKEN;

    let body;
    let renderMode;

    if (token) {
      try {
        body = await fetchWithBrowserless(target, token);
        renderMode = 'browserless';
      } catch (e) {
        // Browserless失敗 → fallback
        try {
          body = await fetchDirect(target);
          renderMode = 'direct-fallback';
        } catch (e2) {
          return new Response(JSON.stringify({ error: `Both renderers failed: ${e2.message}` }), {
            status: 502,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }
    } else {
      // トークン未設定 → direct fetch
      try {
        body = await fetchDirect(target);
        renderMode = 'direct';
      } catch (e) {
        return new Response(JSON.stringify({ error: `Fetch failed: ${e.message}` }), {
          status: 502,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'X-Proxied-Url': target,
        'X-Proxy': 'sdd-cors-proxy',
        'X-Render-Mode': renderMode,
      },
    });
  },
};
