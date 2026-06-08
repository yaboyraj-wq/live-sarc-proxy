/**
 * Minimal standalone Twitch m3u8 proxy (for use outside Cloudflare Pages).
 * Deploy this to Railway, Render, Fly.io, a VPS, etc. (anything with normal egress IPs).
 *
 * Usage in your client JS:
 *   const PROXY_BASE = 'https://your-proxy.railway.app';
 *   const proxyFn = (url) => `${PROXY_BASE}/api/proxy?url=${encodeURIComponent(url)}${clientIp ? `&ip=${encodeURIComponent(clientIp)}` : ''}`;
 *
 * Then use the same proxyFn you already have in live-stream.js and main.js.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const ALLOWED_HOSTS = [
  'usher.twitchapps.com',
  'video-edge',
  'twitchsvc.net',
  'twitch.tv',
  'cloudfront.net',
  'fastly.net',
];

const PORT = process.env.PORT || 3000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache, no-store');
}

function proxyRequest(targetUrl, clientIp, res) {
  console.log('Attempting to proxy target:', targetUrl);

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    console.error('Invalid target URL:', targetUrl);
    res.writeHead(400);
    res.end('Invalid URL');
    return;
  }

  const hostAllowed = ALLOWED_HOSTS.some(h => parsedTarget.hostname.includes(h));
  if (!hostAllowed) {
    console.warn('Host not allowed:', parsedTarget.hostname);
    res.writeHead(403);
    res.end('Host not allowed');
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Tesla) AppleWebKit/537.36',
    'Accept': 'application/x-mpegURL, application/vnd.apple.mpegurl, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://www.twitch.tv',
    'Referer': 'https://www.twitch.tv/',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };

  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp;
  }

  const lib = targetUrl.startsWith('https') ? https : http;

  const proxyReq = lib.get(targetUrl, { headers }, (proxyRes) => {
    const contentType = proxyRes.headers['content-type'] || '';
    const isPlaylist = contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8');

    if (isPlaylist) {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        const rewritten = body.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          if (!trimmed.startsWith('http')) {
            return baseUrl + trimmed;
          }
          return line;
        }).join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          ...Object.fromEntries(Object.entries(setCors({})).map(([k,v]) => [k.toLowerCase(), v])),
        });
        res.end(rewritten);
      });
    } else {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': contentType || 'video/mp2t',
        ...Object.fromEntries(Object.entries(setCors({})).map(([k,v]) => [k.toLowerCase(), v])),
      });
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy fetch error for', targetUrl, err);
    res.writeHead(502);
    res.end('Proxy error: ' + err.message);
  });
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Simple health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK - proxy is running');
    return;
  }

  if (req.url.startsWith('/api/proxy')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = urlObj.searchParams.get('url');
    const clientIp = urlObj.searchParams.get('ip') || '';

    console.log('Incoming proxy request for:', targetUrl, 'clientIp:', clientIp || 'none');

    if (!targetUrl) {
      res.writeHead(400);
      res.end('Missing url parameter');
      return;
    }

    proxyRequest(targetUrl, clientIp, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found. Use /api/proxy?url=...');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Twitch proxy listening on port ${PORT} (bound to 0.0.0.0)`);
});
