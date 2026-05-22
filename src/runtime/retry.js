const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
]);

const HARD_KEYWORDS = [
  'unauthor', 'forbidden', 'invalid api key', 'invalid_api_key',
  'permission denied', 'no such model', 'model not found',
  'invalid model', 'missing api key', 'authentication',
  'cyber_policy', 'content was flagged', 'cybersecurity risk',
];

export function isRetryable(err) {
  if (!err) return false;
  if (err.retryable === false) return false;
  if (err.retryable === true) return true;
  if (err.name === 'AbortError') return true;
  const code = err.code || err.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (Number.isFinite(status)) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }
  const msg = String(err.message || err).toLowerCase();
  if (HARD_KEYWORDS.some((kw) => msg.includes(kw))) return false;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  if (msg.includes('socket hang up') || msg.includes('network')) return true;
  if (msg.includes('rate limit') || msg.includes('overloaded') || msg.includes('temporarily unavailable')) return true;
  return false;
}

export function backoffDelay({ attempt, baseMs, capMs }) {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(capMs, Math.round(exp + jitter));
}

export async function runWithRetry({ fn, attempts, baseMs, capMs, onRetry, signal }) {
  let lastErr;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = backoffDelay({ attempt, baseMs, capMs });
      onRetry?.({ attempt: attempt + 1, totalAttempts: attempts + 1, delayMs: delay, err });
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
