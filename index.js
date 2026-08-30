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
  Const路线=路由.得到(路径名);
  如果 (!路线) {
    控制台.日志('[ERROR]路由未找到：${路径名}‘)；
res.WriteHead(404, corsHeaders);
    res.结束(JSON.使字符串化({ 误差: '未知路径' }));
    返回;
  }

  如果 (req.方法!==路线.方法) {
    控制台.日志('[error]方法不允许：${req.方法}，期望：${路线.方法}‘)；
res.WriteHead(405, corsHeaders);
    res.结束(JSON.使字符串化({ 误差: '方法不允许' }));
    返回;
  }

  //构建上游URL
  ConstupstreamPathFull=`${default_UPSTREAM_BASE_URL}/${路线.上游路径}`;
  控制台.日志('[上游]${req.方法}${upstreamPathFull}')；

  // 构建上游请求头
  ConstupstreamHeaders={};
  
  如果 (req.页眉['内容类型']) {
    upstreamHeaders['内容类型']=req.页眉['内容类型'];
  } 其他 如果 (req.方法!=='GET') {
    upstreamHeaders['内容类型']='应用程序/约翰逊;
  }

  如果 (req.页眉.授权) {
    upstreamHeaders['授权']=req.页眉.授权;
  }

  //解析url
  让upstreamUrlObj;
  尝试 {
    upstreamUrlObj=新的 URL(upstreamPathFull);
  } 赶上 (e) {
    控制台.误差('[ERROR]URL解析失败：${upstreamPathFull}'，e.消息)；
res.WriteHead(400, corsHeaders);
    res.结束(JSON.使字符串化({ 误差: 'URL格式错误', 详细资料: e.消息 }));
    返回;
  }

  Const协议=upstreamUrlObj.协议==='https：' ? HTTPS : HTTP;
  Const港口=upstreamUrlObj.港口||(upstreamUrlObj.协议==='https：' ? 443 : 80);

  控制台.日志('[REQUEST]${upstreamUrlObj。主机名}：${港口}${upstreamUrlObj.路径名}‘)；

  // 转发请求
  ConstproxyReq=协议.请求(
    {
      主机名: upstreamUrlObj.主机名,
      港口: 港口,
      路径: upstreamUrlObj.路径名+upstreamUrlObj.搜索,
      方法: req.方法,
      页眉: upstreamHeaders,
      超时: 200000, //200秒
    },
    (proxyRes)=>{
      控制台.日志('[response]状态：${proxyRes.statusCode}')；
      
      让ResponseBody='';

      proxyRes.在……之上('数据', (大块)=>{
        ResponseBody+=大块;
      });

      proxyRes.在……之上('结束', ()=>{
        让finalBody=ResponseBody;

        // 尝试转换响应格式
        尝试 {
          ConstjsonData=JSON.解析(ResponseBody);
          
          如果 (jsonData.数据 && jsonData.数据.选择) {
            控制台.日志('[FORMAT]转换为OpenAI格式‘)；
            finalBody=JSON.使字符串化(jsonData.数据);
          }
        } 赶上 (e) {
          // 保持原样
        }

        ConstresponseHeaders={
          ...corsHeaders,
          '内容类型': 'application/json；charset=utf-8',
        };

        res.WriteHead(proxyRes.statusCode||200, responseHeaders);
        res.结束(finalBody);
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
