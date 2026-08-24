1最好用版本中转：
// Cloudflare 控制面板单文件 Worker。
const DEFAULT_UPSTREAM_BASE_URL = 'https://ollama.com/v1';
const ROUTES = new Map([
['/chat/completions', { method: 'POST', upstreamPath: 'chat/completions' }],
['/models', { method: 'GET', upstreamPath: 'models' }],
]);

function jsonResponse(body, status, corsHeaders) {
const headers = new Headers(corsHeaders);
headers.set('Content-Type', 'application/json; charset=utf-8');
return new Response(JSON.stringify(body), { status, headers });
}

function getCorsHeaders(request, env) {
const requestOrigin = request.headers.get('Origin') || '';
const configuredOrigins = String(env.ALLOWED_ORIGINS || '*')
.split(',')
.map(origin => origin.trim())
.filter(Boolean);

const allowAnyOrigin = configuredOrigins.length === 0 || configuredOrigins.includes('*');

if (!allowAnyOrigin && requestOrigin && !configuredOrigins.includes(requestOrigin)) {
return null;
}

return new Headers({
'Access-Control-Allow-Origin': allowAnyOrigin ? '*' : (requestOrigin || configuredOrigins[0]),
'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
'Access-Control-Expose-Headers': 'Content-Type, X-Request-Id, X-Ratelimit-Limit-Requests, X-Ratelimit-Remaining-Requests, X-Ratelimit-Limit-Tokens, X-Ratelimit-Remaining-Tokens',
'Access-Control-Max-Age': '86400',
'Vary': 'Origin',
});
}

function normalizePath(pathname) {
if (pathname === '/') return pathname;
return pathname.replace(/\/+$/, '');
}

function buildUpstreamHeaders(request) {
const headers = new Headers();
for (const name of ['Authorization', 'Content-Type', 'Accept']) {
const value = request.headers.get(name);
if (value) headers.set(name, value);
}
return headers;
}

function buildUpstreamUrl(incomingUrl, route, env) {
const configuredBaseUrl = String(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL)
.trim()
.replace(/\/+$/, '');
const baseUrl = new URL(`${configuredBaseUrl}/`);
if (!['http:', 'https:'].includes(baseUrl.protocol)) {
throw new Error('UPSTREAM_BASE_URL 必须使用 http 或 https');
}
const upstreamUrl = new URL(route.upstreamPath, baseUrl);
upstreamUrl.search = incomingUrl.search;
return upstreamUrl;
}

function cleanJsonResponse(text) {
// 移除 ```json 和 ``` 包装
let cleaned = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
// 尝试找到第一个 { 和最后一个 }，提取 JSON
const firstBrace = cleaned.indexOf('{');
const lastBrace = cleaned.lastIndexOf('}');
if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
cleaned = cleaned.substring(firstBrace, lastBrace + 1);
}
return cleaned;
}

export default {
async fetch(request, env) {
const corsHeaders = getCorsHeaders(request, env);
if (!corsHeaders) {
return jsonResponse({ error: '来源不允许' }, 403, new Headers());
}

const incomingUrl = new URL(request.url);
const pathname = normalizePath(incomingUrl.pathname);

if (pathname === '/health') {
if (request.method !== 'GET') {
return jsonResponse({ error: '方法不允许' }, 405, corsHeaders);
}
return jsonResponse({ ok: true, upstream: 'cline-bot-api-v1' }, 200, corsHeaders);
}

const route = ROUTES.get(pathname);
if (!route) {
return jsonResponse({ error: '未知路径' }, 404, corsHeaders);
}

if (request.method === 'OPTIONS') {
return new Response(null, { status: 204, headers: corsHeaders });
}

if (request.method !== route.method) {
const headers = new Headers(corsHeaders);
headers.set('Allow', `${route.method}, OPTIONS`);
return jsonResponse({ error: '方法不允许' }, 405, headers);
}

try {
const upstreamUrl = buildUpstreamUrl(incomingUrl, route, env);
const upstreamResponse = await fetch(upstreamUrl, {
method: request.method,
headers: buildUpstreamHeaders(request),
body: request.method === 'GET' ? null : request.body,
redirect: 'manual',
});

// 获取原始响应体
const responseText = await upstreamResponse.text();
let finalBody = responseText;

// 尝试解析 JSON 并转换格式
try {
// 先清理可能的 Markdown 代码块
const cleanedText = cleanJsonResponse(responseText);
const jsonData = JSON.parse(cleanedText);
// 如果 Cline 返回 { data: { choices: [...], ... }, success: true }
// 改成 { choices: [...], ... } 格式（标准 OpenAI 格式）
if (jsonData.data && jsonData.data.choices) {
finalBody = JSON.stringify(jsonData.data);
} else {
finalBody = JSON.stringify(jsonData);
}
} catch (parseError) {
// 如果还是解析失败，保持原样
finalBody = responseText;
}

const responseHeaders = new Headers(upstreamResponse.headers);
for (const [name, value] of corsHeaders) {
responseHeaders.set(name, value);
}
responseHeaders.delete('Set-Cookie');
responseHeaders.set('Content-Type', 'application/json; charset=utf-8');

return new Response(finalBody, {
status: upstreamResponse.status,
statusText: upstreamResponse.statusText,
headers: responseHeaders,
});
} catch (error) {
return jsonResponse({
error: '上游请求失败',
message: error instanceof Error ? error.message : String(error),
}, 502, corsHeaders);
}
},
};
