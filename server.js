require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { connectDB, verifyCredentials } = require('./db');
const { startTelegramBot } = require('./bot');

// Connect to MongoDB and start Telegram Bot
connectDB();
startTelegramBot();

const PORT = process.env.PORT || 3000;
const TARGET_HOST = 'v2.fiveplay.lol';
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const DEFAULT_GAME_PATH = '/game.html?mode=sandbox&cfg=1_3-american';

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch (e) {
      list[name] = value;
    }
  });
  return list;
}

function isAuthenticated(req) {
  if (!req || !req.headers) return false;
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return false;

  // Direct regex check: robust against encoding and malformed cookies from upstream/third-party scripts
  if (/(?:^|;\s*)sparky_auth=(?:1|"1"|true)(?:;|$)/i.test(cookieHeader)) {
    return true;
  }

  try {
    const cookies = parseCookies(cookieHeader);
    const auth = String(cookies['sparky_auth'] || '').replace(/^["']|["']$/g, '');
    return auth === '1' || auth === 'true';
  } catch (e) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Endpoint to handle login authentication via MongoDB
  if (req.method === 'POST' && parsedUrl.pathname === '/api/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        const auth = await verifyCredentials(username, password);

        if (auth.valid) {
          const cookieExpireDate = new Date(Date.now() + 259200 * 1000).toUTCString();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [
              `sparky_auth=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=259200; Expires=${cookieExpireDate}`,
              `sparky_user=${encodeURIComponent(auth.user.username)}; Path=/; SameSite=Lax; Max-Age=259200; Expires=${cookieExpireDate}`
            ]
          });
          return res.end(JSON.stringify({
            success: true,
            user: auth.user.username,
            expiresAt: auth.user.expiresAt,
            daysRemaining: auth.user.daysRemaining
          }));
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: auth.error }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, message: 'Invalid request body' }));
      }
    });
    return;
  }

  // Session check endpoint
  if (req.method === 'GET' && parsedUrl.pathname === '/api/session') {
    const authed = isAuthenticated(req);
    const cookies = parseCookies(req.headers.cookie);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      authenticated: authed,
      user: authed ? (cookies['sparky_user'] || 'Operator') : null
    }));
  }

  // Public config endpoint (Telegram bot URL & Instagram)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/config') {
    const botUser = process.env.TELEGRAM_BOT_USERNAME || 'sparky_access_bot';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      telegramBotUrl: `https://t.me/${botUser.replace('@', '')}`,
      telegramChannelUrl: process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/sparky_channel',
      instagramUrl: process.env.INSTAGRAM_URL || 'https://www.instagram.com/sparky.drip'
    }));
  }

  // Logout endpoint
  if (parsedUrl.pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': [
        'sparky_auth=0; Path=/; HttpOnly; Max-Age=0',
        'sparky_user=; Path=/; Max-Age=0'
      ],
      'Location': '/'
    });
    return res.end();
  }

  // ALWAYS serve login page for root "/" and "/login" first
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/login') {
    const loginHtmlPath = path.join(__dirname, 'login.html');
    fs.readFile(loginHtmlPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Error loading login page');
      }
      const authed = isAuthenticated(req);
      const cookies = parseCookies(req.headers.cookie);
      const user = authed ? (cookies['sparky_user'] || 'Operator') : null;
      const initialSessionScript = `<script>window.__INITIAL_SESSION__ = ${JSON.stringify({ authenticated: authed, user })};</script>`;
      const renderedHtml = data.replace('</head>', `${initialSessionScript}\n</head>`);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderedHtml);
    });
    return;
  }

  // Check if authenticated before ANY game route or asset is accessed
  const authed = isAuthenticated(req);
  if (!authed) {
    // If not authenticated, redirect to login page
    res.writeHead(302, { 'Location': '/' });
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
