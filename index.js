import http from 'http';
import https from 'https';
import { URL } from 'url';

const DEFAULT_UPSTREAM_BASE_URL = '[https://ollama.com/v1](https://ollama.com/v1)';
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

// 专门用于清洗模型返回的非法 JSON / Markdown / 带有 // 注释的字符串
function cleanContentString(content) {
  if (typeof content !== 'string') return content;

  let cleaned = content;

  // 1. 去除 Markdown 代码块包裹 ```json 和 ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // 2. 尝试提取真正的 JSON 主体 {...}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  // 3. 移除 JSON 内部出现的单行注释 (例如 // Role 1)
  cleaned = cleaned.replace(/\/\/[^\n"]*(?=\n|")/g, '');

  return cleaned.trim();
}

function proxyRequest(req, res) {
  const corsHeaders = getCorsHeaders();
  const pathname = normalizePath(new URL(req.url, `http://${req.headers.host}`).pathname);

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  if (pathname === '/health') {
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ ok: true, upstream: 'ollama-api-v1' }));
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

  const upstreamPathFull = `${DEFAULT_UPSTREAM_BASE_URL}/${route.upstreamPath}`;
  const upstreamHeaders = {};
  
  if (req.headers['content-type']) {
    upstreamHeaders['Content-Type'] = req.headers['content-type'];
  } else if (req.method !== 'GET') {
    upstreamHeaders['Content-Type'] = 'application/json';
  }

  if (req.headers.authorization) {
    upstreamHeaders['Authorization'] = req.headers.authorization;
  }

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

          // 自动清洗 choices 内返回的 content 字符串
          if (jsonData.choices && Array.isArray(jsonData.choices)) {
            jsonData.choices.forEach((choice) => {
              if (choice.message && choice.message.content) {
                choice.message.content = cleanContentString(choice.message.content);
              }
            });
            finalBody = JSON.stringify(jsonData);
          } else if (jsonData.data && jsonData.data.choices) {
            jsonData.data.choices.forEach((choice) => {
              if (choice.message && choice.message.content) {
                choice.message.content = cleanContentString(choice.message.content);
              }
            });
            finalBody = JSON.stringify(jsonData.data);
          }
        } catch (e) {
          console.error('[CLEAN ERROR] JSON 过滤解析失败:', e.message);
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
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({ error: '上游请求失败', message: error.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, corsHeaders);
    res.end(JSON.stringify({ error: '网关超时', message: '上游服务器响应超时' }));
  });

  if (req.method !== 'GET') {
    req.on('data', (chunk) => proxyReq.write(chunk));
    req.on('end', () => proxyReq.end());
  } else {
    proxyReq.end();
  }
}

const server = http.createServer(proxyRequest);
server.listen(PORT, () => {
  console.log(`✅ 清洗服务运行在端口 ${PORT}`);
});
