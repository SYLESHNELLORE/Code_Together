/** Byte-bounded output collector shared by the sandbox runner and job service. */
export class BoundedOutput {
    maxBytes;
    chunks = [];
    bytes = 0;
    truncated = false;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
    }
    push(chunk) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        if (buffer.length === 0)
            return;
        const remaining = this.maxBytes - this.bytes;
        if (remaining <= 0) {
            this.truncated = true;
            return;
        }
        if (buffer.length > remaining) {
            this.chunks.push(buffer.subarray(0, remaining));
            this.bytes += remaining;
            this.truncated = true;
            return;
        }
        this.chunks.push(buffer);
        this.bytes += buffer.length;
    }
    get isTruncated() {
        return this.truncated;
    }
    get length() {
        return this.bytes;
    }
    toString() {
        return Buffer.concat(this.chunks, this.bytes).toString('utf8');
    }
}
/** Defensive cap for output returned by any runner implementation. */
export function capOutput(value, maxBytes) {
    const buffer = Buffer.from(value, 'utf8');
    if (buffer.length <= maxBytes)
        return { text: value, truncated: false };
    return {
        // Decode a cut buffer; an incomplete trailing code point becomes U+FFFD.
        text: buffer.subarray(0, maxBytes).toString('utf8'),
        truncated: true,
    };
}
