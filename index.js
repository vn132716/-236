import http from 'http';
import https from 'https';
import { URL } from 'url';

const DEFAULT_UPSTREAM_BASE_URL = 'https://ollama.com/v1';
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

function proxyRequest(req, res) {
  const corsHeaders = getCorsHeaders();
  const pathname = normalizePath(new URL(req.url, `http://${req.headers.host}`).pathname);

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // 健康检查
  if (pathname === '/health') {
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ ok: true, upstream: 'ollama-api-v1' }));
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
    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ error: '未知路径' }));
    return;
  }

  if (req.method !== route.method) {
    console.log(`[ERROR] 方法不允许: ${req.method}, 期望: ${route.method}`);
    res.writeHead(405, corsHeaders);
    res.end(JSON.stringify({ error: '方法不允许' }));
    return;
  }

  // 构建上游 URL
  const upstreamPathFull = `${DEFAULT_UPSTREAM_BASE_URL}/${route.upstreamPath}`;
  console.log(`[UPSTREAM] ${req.method} ${upstreamPathFull}`);

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
    console.error(`[ERROR] URL 解析失败: ${upstreamPathFull}`, e.message);
    res.writeHead(400, corsHeaders);
    res.end(JSON.stringify({ error: 'URL 格式错误', details: e.message }));
    return;
  }

  const protocol = upstreamUrlObj.protocol === 'https:' ? https : http;
  const port = upstreamUrlObj.port || (upstreamUrlObj.protocol === 'https:' ? 443 : 80);

  console.log(`[REQUEST] ${upstreamUrlObj.hostname}:${port}${upstreamUrlObj.pathname}`);

  // 转发请求
  const proxyReq = protocol.request(
    {
      hostname: upstreamUrlObj.hostname,
      port: port,
      path: upstreamUrlObj.pathname + upstreamUrlObj.search,
      method: req.method,
      headers: upstreamHeaders,
      timeout: 600000, // 600 秒
    },
    (proxyRes) => {
      console.log(`[RESPONSE] Status: ${proxyRes.statusCode}`);
      
      let responseBody = '';

      proxyRes.on('data', (chunk) => {
        responseBody += chunk;
      });

      proxyRes.on('end', () => {
        let finalBody = responseBody;

        // 尝试转换响应格式
        try {
          const jsonData = JSON.parse(responseBody);
          
          if (jsonData.data && jsonData.data.choices) {
            console.log(`[FORMAT] 转换为 OpenAI 格式`);
            finalBody = JSON.stringify(jsonData.data);
          }
        } catch (e) {
          // 保持原样
        }

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
    console.error(`[ERROR] 代理请求失败:`, error.code, error.message);
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({
      error: '上游请求失败',
      message: error.message,
    }));
  });

  proxyReq.on('timeout', () => {
    console.error(`[ERROR] 代理请求超时`);
    proxyReq.destroy();
    res.writeHead(504, corsHeaders);
    res.end(JSON.stringify({
      error: '网关超时',
      message: '上游服务器响应超时',
    }));
  });

  // 转发请求体
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

// 启动服务器
const server = http.createServer(proxyRequest);
server.listen(PORT, () => {
  console.log(`✅ 中转服务器运行在端口 ${PORT}`);
  console.log(`📡 上游服务: ${DEFAULT_UPSTREAM_BASE_URL}`);
});
