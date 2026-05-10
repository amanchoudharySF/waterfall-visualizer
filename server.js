#!/usr/bin/env node
/**
 * Waterfall Visualizer – local proxy server
 * Serves the static HTML and proxies /api/waterfall/* → Salesforce API
 * Handles token refresh via SOAP login automatically.
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL: WHATWGURL } = require('url');

// Load .env file if present (local development)
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
} catch (_) { /* no .env file — using system env vars */ }

const PORT          = process.env.PORT       || 7823;
const HTTPS_PORT    = 7824;
const SF_INSTANCE   = process.env.SF_INSTANCE || 'https://pricingfittest2.test1.my.pc-rnd.salesforce.com';
const SF_USERNAME   = process.env.SF_USERNAME  || '';
const SF_PASSWORD   = process.env.SF_PASSWORD  || '';
const SF_API_VER    = process.env.SF_API_VER   || 'v66.0';

if (!SF_USERNAME || !SF_PASSWORD) {
  console.error('ERROR: SF_USERNAME and SF_PASSWORD environment variables are required.');
  process.exit(1);
}

let cachedToken     = null;
let tokenExpiry     = 0;   // epoch ms

/* ── SOAP login to get a fresh session token ── */
function getSoapToken() {
  return new Promise((resolve, reject) => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${SF_USERNAME}</urn:username>
      <urn:password>${SF_PASSWORD}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

    const parsed   = new URL(SF_INSTANCE);
    const options  = {
      hostname: parsed.hostname,
      port: 443,
      path: '/services/Soap/u/59.0',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'SOAPAction':   'login',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const m = data.match(/<sessionId>([^<]+)<\/sessionId>/);
        if (m) resolve(m[1]);
        else reject(new Error('SOAP login failed: ' + data.slice(0, 400)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  console.log('[auth] Refreshing Salesforce session token…');
  cachedToken  = await getSoapToken();
  tokenExpiry  = Date.now() + 90 * 60 * 1000; // 90 min (tokens last 2h)
  console.log('[auth] Token refreshed, valid for 90 min.');
  return cachedToken;
}

/* ── Proxy a Salesforce REST call ── */
function sfGet(token, sfPath) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(SF_INSTANCE);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: sfPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ── HTTP server ── */
async function requestHandler(req, res) {
  const parsed = new WHATWGURL(req.url, 'http://localhost');
  const p      = parsed.pathname;

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Proxy: /api/lineitems/:executionKey ──
  const liMatch = p.match(/^\/api\/lineitems\/([^/]+)$/);
  if (liMatch) {
    const [, executionKey] = liMatch;
    try {
      const token  = await getToken();
      const query  = `SELECT+ExecutionTypeKey,Status+FROM+PricingProcessExecution+WHERE+ExecutionKey='${executionKey}'+AND+ExecutionType='Pricing_Line'+ORDER+BY+Name+ASC`;
      const sfPath = `/services/data/${SF_API_VER}/query/?q=${query}`;
      console.log(`[proxy] GET ${sfPath}`);
      let result   = await sfGet(token, sfPath);
      if (result.status === 401) {
        cachedToken = null;
        const fresh = await getToken();
        result      = await sfGet(fresh, sfPath);
      }
      // ExecutionTypeKey format: "<waterfallExecId>_<lineItemId>"
      // e.g. "143706014172907_LineItem5" → waterfallExecId=143706014172907, lineItemId=LineItem5
      const body   = JSON.parse(result.body);
      let waterfallExecutionId = null;
      const lineItems = (body.records || []).map(r => {
        const key = r.ExecutionTypeKey || '';
        const match = key.match(/^(.+)_(.+)$/);
        if (match) {
          if (!waterfallExecutionId) waterfallExecutionId = match[1];
          return { id: match[2], status: r.Status };
        }
        return { id: key, status: r.Status };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lineItems, waterfallExecutionId }));
    } catch (err) {
      console.error('[proxy error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Proxy: /api/waterfall/:lineItemId/:executionId ──
  const wfMatch = p.match(/^\/api\/waterfall\/([^/]+)\/([^/]+)$/);
  if (wfMatch) {
    const [, lineItemId, executionId] = wfMatch;
    try {
      const token   = await getToken();
      const sfPath  = `/services/data/${SF_API_VER}/connect/core-pricing/waterfall/${lineItemId}/${executionId}`;
      console.log(`[proxy] GET ${sfPath}`);
      let result    = await sfGet(token, sfPath);

      // If 401, force-refresh token and retry once
      if (result.status === 401) {
        console.log('[auth] 401 received, forcing token refresh…');
        cachedToken = null;
        const fresh = await getToken();
        result      = await sfGet(fresh, sfPath);
      }

      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (err) {
      console.error('[proxy error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static file serving ──
  let filePath = path.join(__dirname, p === '/' ? 'index.html' : p);
  // prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext     = path.extname(filePath).toLowerCase();
  const mimeMap = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const mime    = mimeMap[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// Plain HTTP server
const httpServer = http.createServer(requestHandler);
httpServer.listen(PORT, () => {
  console.log(`✓ HTTP  → http://localhost:${PORT}`);
});

// HTTPS handled by hosting platform (Railway/Render) in production
