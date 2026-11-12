/**
 * Zero-dependency local HTTP wrapper for `lambda/index.mjs`.
 * Emulates an AWS Lambda Function URL (payload format v2.0) with CORS enabled
 * so local development (`npm run dev:api` or Docker `geurtsgaming-api`) works
 * 100% offline with zero AWS bills or credentials.
 */

process.env.DEFAULT_SITE ||= 'geurtsgaming';

import { createServer } from 'node:http';
import { handler } from './index.mjs';

const PORT = Number(process.env.PORT || 4322);
const HOST = process.env.HOST || '0.0.0.0';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());

  const event = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    queryStringParameters,
    headers: req.headers,
    requestContext: {
      http: {
        method: req.method || 'GET',
        path: url.pathname,
        sourceIp: req.socket.remoteAddress || '127.0.0.1',
        userAgent: req.headers['user-agent'] || '',
      },
    },
    body: rawBody || undefined,
    isBase64Encoded: false,
  };

  try {
    const result = await handler(event);
    const statusCode = result?.statusCode || 200;
    const headers = {
      ...CORS_HEADERS,
      ...(result?.headers || {}),
    };
    res.writeHead(statusCode, headers);
    res.end(result?.body || '');
  } catch (err) {
    console.error('[dev-server] Unhandled error:', err);
    res.writeHead(500, { ...CORS_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[geurtsgaming-api] Local Lambda server listening at http://${HOST}:${PORT}`);
});
