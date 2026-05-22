import { createServer } from 'node:http';

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function isLocalhost(req, host) {
  const remote = req.socket?.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  return host === '127.0.0.1' || host === 'localhost';
}

export function startHttpServer({ host, port, logger, scheduler }) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true, service: 'a2a' });
        return;
      }
      if (req.url?.startsWith('/sessions')) {
        if (!isLocalhost(req, host)) {
          writeJson(res, 403, { ok: false, error: 'admin_localhost_only' });
          return;
        }
        if (req.method === 'GET' && req.url === '/sessions') {
          writeJson(res, 200, { ok: true, sessions: scheduler.listSessions() });
          return;
        }
        const stopMatch = req.url.match(/^\/sessions\/([^/]+)\/stop$/);
        if (req.method === 'POST' && stopMatch) {
          const id = decodeURIComponent(stopMatch[1]);
          const body = await readJson(req);
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid_json' });
            return;
          }
          const reason = body?.reason || 'admin-stop';
          const result = await scheduler.stopById(id, reason);
          writeJson(res, result.ok ? 200 : 404, result);
          return;
        }
      }
      writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      logger.error('HTTP handler failed:', err);
      writeJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });
  server.listen(port, host, () => logger.info(`A2A HTTP listening on http://${host}:${port}`));
  return server;
}
