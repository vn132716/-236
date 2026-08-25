import http from 'http';
import https from 'https';
import { URL } from 'url';

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
      res.end("Railway 中转代理运行正常！（流式透传模式）");
      return;
  }

  // 拼接上游地址
  let upstreamPathFull = UPSTREAM_BASE_URL;
  if (pathAndQuery.startsWith('/v1')) {
    upstreamPathFull = 'https://ollama.com' + pathAndQuery;
  } else {
    upstreamPathFull = UPSTREAM_BASE_URL + pathAndQuery;
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

  const proxyReq = protocol.request(
    {
      hostname: upstreamUrlObj.hostname,
      port: port,
      path: upstreamUrlObj.pathname + upstreamUrlObj.search,
      method: req.method,
      headers: upstreamHeaders,
      timeout: 600000, // 核心需求：保持 600 秒不断开
    },
    (proxyRes) => {
      // 组装返回的响应头
      const responseHeaders = { ...proxyRes.headers, ...corsHeaders };
      res.writeHead(proxyRes.statusCode || 200, responseHeaders);
      
      // 这一次不用任何自作聪明的数据拦截清洗
      // 直接使用管道(pipe)，实现真正的打字机流式输出，彻底保证 NAI 模板的 `//` 格式不被破坏
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({ error: '上游请求失败', message: error.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, corsHeaders);
    res.end(JSON.stringify({ error: '网关超时 (600s)' }));
  });

  // 把你的发出的请求也原样实时转发过去
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const server = http.createServer(proxyRequest);
server.listen(PORT, () => console.log(`✅ 中转服务已启动并运行在端口 ${PORT}，流式纯净透传模式已开启`));
