const buckets = new Map();
/** Test helper. Production limits are intentionally not bypassable at runtime. */
export function resetRateLimits() {
    buckets.clear();
}
function prune(now) {
    if (buckets.size < 5_000)
        return;
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now)
            buckets.delete(key);
    }
}
/**
 * Small in-process fixed-window limiter. Adequate for a single local API
 * instance; a multi-instance deployment should use a shared store (Redis).
 */
export function rateLimit(options) {
    return (req, res, next) => {
        const now = Date.now();
        prune(now);
        const discriminator = options.key?.(req) ?? '';
        const key = `${options.keyPrefix}:${req.ip ?? 'unknown'}:${discriminator}`;
        const existing = buckets.get(key);
        if (!existing || existing.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + options.windowMs });
            next();
            return;
        }
        existing.count += 1;
        if (existing.count <= options.max) {
            next();
            return;
        }
        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
            error: {
                code: 'RATE_LIMITED',
                message: `Too many attempts. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
            },
        });
    };
}
