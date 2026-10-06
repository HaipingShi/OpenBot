/**
 * stealth-client.ts
 * Realistic browser protocol impersonation, proxy adapter, and jitter delay.
 */

export interface StealthFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": DEFAULT_USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "max-age=0",
  "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/**
 * Sleeps with a random jitter around baseMs (Gaussian/Poisson approximation).
 * e.g., baseMs = 1500, jitterMs = 800 -> sleeps between 700ms and 2300ms.
 */
export async function sleepJitter(baseMs = 1500, jitterMs = 800): Promise<number> {
  const variation = (Math.random() * 2 - 1) * jitterMs;
  const delay = Math.max(200, Math.round(baseMs + variation));
  await new Promise((resolve) => setTimeout(resolve, delay));
  return delay;
}

/**
 * Stealth fetch that applies realistic headers, supports proxy if configured,
 * and handles adaptive exponential backoff on 429/403.
 */
export async function stealthFetch(
  url: string,
  options: StealthFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 25000;
  const maxRetries = options.maxRetries ?? 3;
  const proxyUrl =
    process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  const mergedHeaders: Record<string, string> = {
    ...BROWSER_HEADERS,
    ...((options.headers as Record<string, string>) || {}),
  };

  let attempt = 0;
  let delay = 1000;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const fetchOpts: any = {
        ...options,
        headers: mergedHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      };

      if (proxyUrl) {
        fetchOpts.proxy = proxyUrl;
      }

      const res = await fetch(url, fetchOpts);

      if (res.status === 429 || res.status === 403) {
        if (attempt <= maxRetries) {
          console.warn(
            `[StealthClient] HTTP ${res.status} on ${url}. Backing off for ${delay}ms (Attempt ${attempt}/${maxRetries})...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2; // exponential backoff
          continue;
        }
      }

      return res;
    } catch (err: any) {
      if (attempt <= maxRetries) {
        console.warn(
          `[StealthClient] Fetch error on ${url}: ${err.message}. Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay *= 1.5;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`[StealthClient] Exceeded max retries (${maxRetries}) for ${url}`);
}
