/** Keep server responses readable without exposing HTML pages or embedded assets. */
export function conciseErrorMessage(value: unknown, fallback = 'Could not complete the Overleaf request.'): string {
    const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
    const sample = raw.slice(0, 8192);
    if (/(?:<|&lt;)\/?[a-z!][^>]*(?:>|&gt;)|data:[^\s,]*[;,]/i.test(sample)) return fallback;
    const message = sample.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return message.length > 320 ? `${message.slice(0, 317)}...` : message || fallback;
}

export function httpErrorMessage(status: number, body: string, contentType = ''): string {
    let explanation: string;
    if (status === 502) {
        explanation = 'The Overleaf server or its gateway is temporarily unavailable. Try again shortly or open the server in your browser.';
    } else if (status === 503) {
        explanation = 'The Overleaf server is temporarily unavailable or undergoing maintenance. Try again shortly.';
    } else if (status === 504 || status === 408) {
        explanation = 'The Overleaf server took too long to respond. Try again shortly.';
    } else if (status >= 500) {
        explanation = 'The Overleaf server could not complete the request. Try again shortly.';
    } else if (status === 429) {
        explanation = 'The Overleaf server received too many requests. Wait a moment before trying again.';
    } else {
        const fallback = status === 403
            ? 'The Overleaf server refused access. Open it in your browser or check your account.'
            : 'The Overleaf server could not complete the request.';
        let detail = body;
        if (/^\s*[\[{]/.test(body)) {
            detail = '';
            try {
                const parsed: unknown = JSON.parse(body.slice(0, 8192));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const fields = parsed as Record<string, unknown>;
                    const message = fields.message ?? fields.error;
                    if (typeof message === 'string') detail = message;
                }
            } catch { /* Invalid or oversized JSON uses the generic explanation. */ }
        }
        explanation = /html/i.test(contentType) ? fallback : conciseErrorMessage(detail, fallback);
    }
    return `${status}: ${explanation}`;
}
