import http from 'http';
import https from 'https';
import { URL } from 'url';

// 固定的上游地址
const UPSTREAM_BASE_URL = 'https://ollama.com/v1';
const PORT = process.env.PORT || 3000;

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': '*',
  };
}

// 专门用于清洗模型返回的非法 JSON / Markdown / 带有 // 注释的字符串
function cleanContentString(content) {
  if (typeof content !== 'string') return content;
  let cleaned = content;
  
  // 1. 去除 Markdown 代码块包裹
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  
  // 2. 提取真正的 JSON 主体 {...}
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
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  let requestUrlObj = new URL(req.url, `http://${req.headers.host}`);
  let pathAndQuery = requestUrlObj.pathname + requestUrlObj.search;
  
  if (pathAndQuery === '/' || pathAndQuery === '') {
      res.writeHead(200, corsHeaders);
      res.end("Railway 中转代理运行正常！");
      return;
  }

  // 智能拼接上游路径，完美支持 /chat/completions 和 /models
  let upstreamPathFull = UPSTREAM_BASE_URL;
  if (pathAndQuery.startsWith('/v1')) {
    upstreamPathFull = 'https://ollama.com' + pathAndQuery;
  } else {
    upstreamPathFull = UPSTREAM_BASE_URL + pathAndQuery;
  }

  const upstreamHeaders = { ...req.headers };
  delete upstreamHeaders.host;
  delete upstreamHeaders['accept-encoding']; // 禁用压缩，防止清洗乱码

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
      timeout: 600000, // 600秒超时
    },
    (proxyRes) => {
      let responseBody = [];

      proxyRes.on('data', (chunk) => { 
        responseBody.push(chunk); 
      });

      proxyRes.on('end', () => {
        let bodyBuffer = Buffer.concat(responseBody);
        let finalBody = bodyBuffer;
        
        // 当返回 JSON 时，自动过滤数据里的污染字符
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try {
            let textBody = bodyBuffer.toString('utf-8');
            let jsonData = JSON.parse(textBody);
            
            // 兼容解包 data 结构
            if (jsonData.data && jsonData.data.choices) {
              jsonData = jsonData.data;
            }

            // 深度清洗 content 里的注释和 markdown
            if (jsonData.choices && Array.isArray(jsonData.choices)) {
              jsonData.choices.forEach((choice) => {
                if (choice.message && choice.message.content) {
                  choice.message.content = cleanContentString(choice.message.content);
                }
              });
              finalBody = JSON.stringify(jsonData);
            }
          } catch (e) {
            // 如果解析失败则保持原样透传
          }
        }

        const responseHeaders = { ...proxyRes.headers, ...corsHeaders };
        delete responseHeaders['content-length'];
        
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
    res.end(JSON.stringify({ error: '网关超时' }));
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.on('data', (chunk) => proxyReq.write(chunk));
    req.on('end', () => proxyReq.end());
  } else {
    proxyReq.end();
  }
}

const server = http.createServer(proxyRequest);
server.listen(PORT, () => console.log(`✅ 中转服务已锁定 https://ollama.com/v1 并运行在端口 ${PORT}`));
