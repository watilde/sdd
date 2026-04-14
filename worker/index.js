/**
 * SDD CORS Proxy — Cloudflare Worker
 *
 * Usage:
 *   GET https://<worker-url>/?url=https://example.com
 *
 * - Fetches the target URL server-side (no CORS restrictions)
 * - Returns HTML with permissive CORS headers
 * - Blocks private/loopback IPs to prevent SSRF
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

export default {
  async fetch(request) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405, headers: CORS_HEADERS
      });
    }

    // ?url= パラメータを取得
    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // URLバリデーション
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return new Response(JSON.stringify({ error: 'Only http/https allowed' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (isPrivateHost(parsed.hostname)) {
      return new Response(JSON.stringify({ error: 'Private/loopback addresses not allowed' }), {
        status: 403,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // ターゲットURLをフェッチ
    let res;
    try {
      res = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SDD-Proxy/1.0; +https://github.com/watilde/sdd)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'en,ja;q=0.9',
        },
        redirect: 'follow',
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: `Fetch failed: ${e.message}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const contentType = res.headers.get('content-type') || 'text/html';
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'X-Proxied-Url': target,
        'X-Proxy': 'sdd-cors-proxy',
      },
    });
  }
};
