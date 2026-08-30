import http from 'http';
import https from 'https';
import { URL } from 'url';

// 修正为 Ollama 官方 API 上游地址
const DEFAULT_UPSTREAM_BASE_URL = 'https://ollama.com/v1';
const PORT = process.env.PORT || 3000;

// 兼容酒馆带 /v1 和不带 /v1 的请求
const ROUTES = new Map([
  ['/v1/chat/completions', { method: 'POST', upstreamPath: 'chat/completions' }],
  ['/chat/completions', { method: 'POST', upstreamPath: 'chat/completions' }],
  ['/v1/models', { method: 'GET', upstreamPath: 'models' }],
  ['/models', { method: 'GET', upstreamPath: 'models' }],
]);

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  };
}

function normalizePath(pathname) {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

function proxyRequest(req, res) {
  const corsHeaders = getCorsHeaders();
  const hostHeader = req.headers.host || 'localhost';
  const pathname = normalizePath(new URL(req.url, `http://${hostHeader}`).pathname);

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // 健康检查
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: DEFAULT_UPSTREAM_BASE_URL }));
    return;
  }

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // 检查路由
  const route = ROUTES.get(pathname);
  if (!route) {
    console.log(`[ERROR] 路由未找到: ${pathname}`);
    res.writeHead(404, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知路径', path: pathname }));
    return;
  }

  if (req.method !== route.method) {
    console.log(`[ERROR] 方法不允许: ${req.method}, 期望: ${route.method}`);
    res.writeHead(405, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '方法不允许' }));
    return;
  }

  // 构建上游 URL
  const upstreamPathFull = `${DEFAULT_UPSTREAM_BASE_URL}/${route.upstreamPath}`;
  
  // 构建上游请求头
  const upstreamHeaders = {};
  if (req.headers['content-type']) {
    upstreamHeaders['Content-Type'] = req.headers['content-type'];
  } else if (req.method !== 'GET') {
    upstreamHeaders['Content-Type'] = 'application/json';
  }
  if (req.headers.authorization) {
    upstreamHeaders['Authorization'] = req.headers.authorization;
  }

  // 解析 URL
  let upstreamUrlObj;
  try {
    upstreamUrlObj = new URL(upstreamPathFull);
  } catch (e) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'URL 格式错误', details: e.message }));
    return;
  }

  const protocol = upstreamUrlObj.protocol === 'https:' ? https : http;
  const port = upstreamUrlObj.port || (upstreamUrlObj.protocol === 'https:' ? 443 : 80);

  // 转发请求
  const proxyReq = protocol.request(
    {
      hostname: upstreamUrlObj.hostname,
      port: port,
      path: upstreamUrlObj.pathname + upstreamUrlObj.search,
      method: req.method,
      headers: upstreamHeaders,
      timeout: 200000, // 200 秒超时
    },
    (proxyRes) => {
      console.log(`[RESPONSE] Status: ${proxyRes.statusCode}`);
      
      // 纯净盲透传：把响应和数据流原封不动交给酒馆/生图插件
      res.writeHead(proxyRes.statusCode || 200, {
        ...corsHeaders,
        ...proxyRes.headers
      });

      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (error) => {
    console.error(`[ERROR] 代理请求失败:`, error.message);
    if (!res.headersSent) {
      res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上游请求失败', message: error.message }));
    }
  });

  proxyReq.on('timeout', () => {
    console.error(`[ERROR] 代理请求超时`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '网关超时', message: '响应超过 200 秒' }));
    }
  });

  // 接收请求体并转发
  if (req.method !== 'GET') {
    req.pipe(proxyReq, { end: true });
  } else {
    proxyReq.end();
  }
}

// 启动服务器
const server = http.createServer(proxyRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 中转服务器运行在端口 ${PORT}`);
  console.log(`📡 上游服务: ${DEFAULT_UPSTREAM_BASE_URL}`);
});
