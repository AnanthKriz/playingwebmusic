const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'v2.fiveplay.lol';
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const DEFAULT_GAME_PATH = '/game.html?mode=sandbox&cfg=1_3-american';

// Valid user credentials (same as configured in login.html)
const VALID_USER = 'aswinsparky';
const VALID_PASS = 'sparky777';

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies['sparky_auth'] === '1';
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Endpoint to handle login authentication
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (username === VALID_USER && password === VALID_PASS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'sparky_auth=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
          });
          return res.end(JSON.stringify({ success: true }));
        }
      } catch (e) {
        // Fallback for form-urlencoded or malformed input
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }));
    });
    return;
  }

  // Logout endpoint
  if (parsedUrl.pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': 'sparky_auth=0; Path=/; HttpOnly; Max-Age=0',
      'Location': '/'
    });
    return res.end();
  }

  // Check if authenticated
  const authed = isAuthenticated(req);

  // If not authenticated and trying to load a page, serve login.html
  if (!authed) {
    // Only serve login for non-asset routes or root
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/login' || parsedUrl.pathname.endsWith('.html')) {
      const loginHtmlPath = path.join(__dirname, 'login.html');
      fs.readFile(loginHtmlPath, 'utf8', (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('Error loading login page');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    } else {
      // Prompt redirect to login for protected assets
      res.writeHead(302, { 'Location': '/' });
      return res.end();
    }
  }

  // If requesting root "/" or "/game.html" without parameters, redirect to the main game URL
  if (parsedUrl.pathname === '/') {
    const params = new URLSearchParams(parsedUrl.search);
    if (!params.has('mode')) params.set('mode', 'sandbox');
    if (!params.has('cfg')) params.set('cfg', '1_3-american');
    res.writeHead(302, { 'Location': `/game.html?${params.toString()}` });
    return res.end();
  }

  if (parsedUrl.pathname === '/game.html' && (!parsedUrl.search || !parsedUrl.searchParams.has('mode'))) {
    const params = new URLSearchParams(parsedUrl.search);
    if (!params.has('mode')) params.set('mode', 'sandbox');
    if (!params.has('cfg')) params.set('cfg', '1_3-american');
    res.writeHead(302, { 'Location': `/game.html?${params.toString()}` });
    return res.end();
  }

  // User is authenticated -> Reverse Proxy to TARGET_ORIGIN
  let targetPath = req.url;

  const proxyHeaders = {
    ...req.headers,
    host: TARGET_HOST,
    origin: TARGET_ORIGIN,
    referer: TARGET_ORIGIN + '/'
  };

  // Prevent sending local dev headers that confuse upstream
  delete proxyHeaders['x-forwarded-for'];
  delete proxyHeaders['x-forwarded-host'];
  delete proxyHeaders['x-forwarded-proto'];

  const proxyReq = https.request(
    {
      hostname: TARGET_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: proxyHeaders
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };

      // Strip or rewrite CSP to avoid blocking on custom domains
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-security-policy-report-only'];

      // WebAssembly SharedArrayBuffer Isolation Headers (required for the game engine)
      responseHeaders['cross-origin-opener-policy'] = 'same-origin';
      responseHeaders['cross-origin-embedder-policy'] = 'credentialless';
      responseHeaders['cross-origin-resource-policy'] = 'cross-origin';

      // Rewrite set-cookie domains so cookies are scoped to this domain
      if (responseHeaders['set-cookie']) {
        responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie =>
          cookie.replace(/domain=[^;]+;?/i, '')
        );
      }

      // Rewrite upstream redirects to remain on this server
      if (responseHeaders['location']) {
        responseHeaders['location'] = responseHeaders['location'].replace(
          new RegExp(`https?:\\/\\/${TARGET_HOST}`, 'i'),
          ''
        );
      }

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: Unable to connect to game server');
    }
  });

  // Pipe any client request body to the target
  req.pipe(proxyReq);
});

// Support WebSocket Upgrade Proxying
server.on('upgrade', (req, socket, head) => {
  if (!isAuthenticated(req)) {
    socket.destroy();
    return;
  }

  const proxyHeaders = {
    ...req.headers,
    host: TARGET_HOST,
    origin: TARGET_ORIGIN
  };

  const proxyReq = https.request({
    hostname: TARGET_HOST,
    port: 443,
    path: req.url,
    method: 'GET',
    headers: proxyHeaders
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n'
    );
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    console.error('WS Proxy Error:', err.message);
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  V SPARKY Proxy Server running on port ${PORT}`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`  Tunnel target: ${TARGET_ORIGIN}${DEFAULT_GAME_PATH}`);
  console.log(`==================================================\n`);
});
