import { HttpError } from '../errors.js';

export interface RequestOptions {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | NodeJS.ReadableStream;
    timeoutMs?: number;
}

export async function requestJson(url: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await request(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return null;
    try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
        throw new HttpError(`Server returned invalid JSON from ${new URL(url).pathname}`, response.status, 'invalid_json_response');
    }
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    timer.unref();
    try {
        const init: RequestInit & { duplex?: 'half' } = {
            method: options.method ?? 'GET',
            signal: controller.signal,
            redirect: 'error',
            ...(options.headers === undefined ? {} : { headers: options.headers })
        };
        if (options.body !== undefined) {
            init.body = options.body as BodyInit;
            init.duplex = 'half';
        }
        const response = await fetch(url, init);
        if (!response.ok) throw await responseError(response);
        return response;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        if ((error as Error).name === 'AbortError') throw new HttpError(`Request timed out: ${new URL(url).pathname}`, 408, 'request_timeout');
        throw new HttpError(`Request failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'network_error');
    } finally {
        clearTimeout(timer);
    }
}

async function responseError(response: Response): Promise<HttpError> {
    const text = await response.text();
    let details: unknown = text;
    let message = `${response.status} ${response.statusText}`;
    let code = 'http_error';
    if (text) {
        try {
            details = JSON.parse(text) as unknown;
            if (details && typeof details === 'object' && !Array.isArray(details)) {
                const object = details as Record<string, unknown>;
                if (typeof object.message === 'string') message = object.message;
                else if (typeof object.error === 'string') message = object.error;
                if (typeof object.code === 'string') code = object.code;
            }
        } catch {
            message = text.slice(0, 500);
        }
    }
    return new HttpError(message, response.status, code, details);
}
