export class ApiError extends Error {
  constructor(status, message, retryAfterMs = null, details = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

// Both HTTP date and seconds are allowed; bound waits so cancellation stays useful.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value.trim() === "") return null;
  const delay = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(60000, Math.max(0, delay)) : null;
}

/** No automatic retries of mutations: sharing, backups and updates are not idempotent. */
export function createClient(
  fetcher = (...args) => fetch(...args),
  onUnauthorized = () => {},
) {
  return async function request(url, { json, responseType, ...options } = {}) {
    const response = await fetcher(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    if (response.ok && responseType === "blob") return response.blob();
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      if (response.status === 401 && !url.includes("/login")) onUnauthorized();
      throw new ApiError(
        response.status,
        data.error || `HTTP ${response.status}`,
        parseRetryAfter(response.headers.get("Retry-After")),
        data,
      );
    }
    return data;
  };
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}
