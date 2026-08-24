import http from 'http';
import https from 'https';
import { URL } from 'url';

const DEFAULT_UPSTREAM_BASE_URL = 'https://https://ollama.com/v1';
const PORT = process.env.PORT || 3000;

const ROUTES = new Map([
  ['/chat/completions', { method: 'POST', upstreamPath: 'chat/completions' }],
  ['/models', { method: 'GET', upstreamPath: 'models' }],
]);

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function normalizePath(pathname) {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

function buildUpstreamUrl(pathname) {
  const baseUrl = DEFAULT_UPSTREAM_BASE_URL.replace(/\/+$/, '');
  const route = ROUTES.get(pathname);
  if (!route) return null;
  return `${baseUrl}/${route.upstreamPath}`;
}

function proxyRequest(req, res) {
  const corsHeaders = getCorsHeaders();
  const pathname = normalizePath(new URL(req.url, `http://${req.headers.host}`).pathname);

  if (pathname === '/health') {
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ ok: true, upstream: 'cline-bot-api-v1' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const route = ROUTES.get(pathname);
  if (!route) {
    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ error: '未知路径' }));
    return;
  }

  if (req.method !== route.method) {
    res.writeHead(405, corsHeaders);
    res.end(JSON.stringify({ error: '方法不允许' }));
    return;
  }

  const upstreamUrl = buildUpstreamUrl(pathname);
  const upstreamUrlObj = new URL(upstreamUrl);

  const upstreamHeaders = {
    'Content-Type': req.headers['content-type'] || 'application/json',
  };
  if (req.headers.authorization) {
    upstreamHeaders.authorization = req.headers.authorization;
  }

  const protocol = upstreamUrlObj.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request(
    {
      hostname: upstreamUrlObj.hostname,
      port: upstreamUrlObj.port,
      path: upstreamUrlObj.pathname + upstreamUrlObj.search,
      method: req.method,
      headers: upstreamHeaders,
      timeout: 600000,
    },
    (proxyRes) => {
      let responseBody = '';

      proxyRes.on('data', (chunk) => {
        responseBody += chunk;
      });

      proxyRes.on('end', () => {
        let finalBody = responseBody;

        try {
          const jsonData = JSON.parse(responseBody);
          if (jsonData.data && jsonData.data.choices) {
            finalBody = JSON.stringify(jsonData.data);
          }
        } catch (e) {}

        const responseHeaders = {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        };

        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        res.end(finalBody);
      });
    }
  );

  proxyReq.on('error', (error) => {
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({ error: '上游请求失败', message: error.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, corsHeaders);
    res.end(JSON.stringify({ error: '网关超时', message: '上游服务器响应超时' }));
  });

  if (req.method !== 'GET') {
    req.on('data', (chunk) => {
      proxyReq.write(chunk);
    });
    req.on('end', () => {
      proxyReq.end();
    });
  } else {
    proxyReq.end();
  }
}

const server = http.createServer(proxyRequest);
server.listen(PORT, () => {
  console.log(`中转服务器运行在 http://localhost:${PORT}`);
});
