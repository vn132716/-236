import http from 'http';
import https from 'https';
import { URL } from 'url';

// 固化你的上游平台地址
const UPSTREAM_BASE_URL = 'https://ollama.com/v1';
const PORT = process.env.PORT || 3000;

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': '*',
  };
}

function proxyRequest(req, res) {
  const corsHeaders = getCorsHeaders();
  
  // 处理跨域预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  let requestUrlObj = new URL(req.url, `http://${req.headers.host}`);
  let pathAndQuery = requestUrlObj.pathname + requestUrlObj.search;
  
  if (pathAndQuery === '/' || pathAndQuery === '') {
      res.writeHead(200, corsHeaders);
      res.end("Railway 中转代理运行正常！（对接 ollama.com/v1 纯净透传模式）");
      return;
  }

  // 智能拼接上游地址：兼容根路径请求与完整的 /v1 路径
  let upstreamPathFull = UPSTREAM_BASE_URL;
  if (pathAndQuery.startsWith('/v1')) {
    upstreamPathFull = 'https://ollama.com' + pathAndQuery;
  } else {
    // 如果请求不带 /v1，自动拼在 baseurl 后面
    upstreamPathFull = UPSTREAM_BASE_URL + pathAndQuery.replace(/^\//, '');
  }

  const upstreamHeaders = { ...req.headers };
  delete upstreamHeaders.host; 

  let upstreamUrlObj;
  try {
    upstreamUrlObj = new URL(upstreamPathFull);
  } catch (e) {
    res.writeHead(400, corsHeaders);
    res.end(JSON.stringify({ error: 'URL 格式错误', details: e.message }));
    return;
  }

  const protocol = upstreamUrlObj.protocol === 'https:' ? https : http;
  const port = upstreamUrlObj.port || (upstreamUrlObj.protocol === 'https:' ? 443 : 80);

  // 防重复响应锁，避免 ERR_HTTP_HEADERS_SENT 崩溃
  let isResSent = false;

  const proxyReq = protocol.request(
    {
      hostname: upstreamUrlObj.hostname,
      port: port,
      path: upstreamUrlObj.pathname + upstreamUrlObj.search,
      method: req.method,
      headers: upstreamHeaders,
      timeout: 600000, // 保持 600 秒长连接
    },
    (proxyRes) => {
      if (isResSent) return;
      isResSent = true;

      // 无损透传响应头和二进制/文本流，绝对不随意篡改返回体
      const responseHeaders = { ...proxyRes.headers, ...corsHeaders };
      res.writeHead(proxyRes.statusCode || 200, responseHeaders);
      
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    if (isResSent) return;
    isResSent = true;
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({ error: '上游请求失败', message: error.message }));
  });

  proxyReq.on('timeout', () => {
    if (isResSent) return;
    isResSent = true;
    proxyReq.destroy();
    res.writeHead(504, corsHeaders);
    res.end(JSON.stringify({ error: '网关超时 (600s)' }));
  });

  // 把客户端发出的请求原样转发
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const server = http.createServer(proxyRequest);
server.listen(PORT, () => console.log(`🚀 中转服务已成功启动并绑定上游 https://ollama.com/v1，监听端口 ${PORT}`));
