import type { Readable } from 'node:stream';

import { request as requestHttp, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';

import { HttpError } from '../errors.js';
import { userAgent } from './user-agent.js';

/** Identify the client on every request unless a caller set its own. */
function withUserAgent(headers: HeadersInit | undefined): Headers {
    const result = new Headers(headers);
    if (!result.has('user-agent')) result.set('user-agent', userAgent());
    return result;
}

export interface RequestOptions {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | NodeJS.ReadableStream;
    timeoutMs?: number;
    bodyTimeoutMs?: number;
}

export interface StreamingResponse {
    status: number;
    statusText: string;
    headers: IncomingHttpHeaders;
    body: Readable;
    trailers: Promise<IncomingHttpHeaders>;
    abort(): void;
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
            headers: withUserAgent(options.headers)
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

export function requestStream(url: string, options: RequestOptions = {}): Promise<StreamingResponse> {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? requestHttps : target.protocol === 'http:' ? requestHttp : undefined;
    if (!transport) return Promise.reject(new HttpError(`Unsupported request protocol: ${target.protocol}`, 0, 'network_error'));
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise<StreamingResponse>((resolve, reject) => {
        let responseReceived = false;
        const request = transport(
            target,
            {
                method: options.method ?? 'GET',
                headers: Object.fromEntries(withUserAgent(options.headers).entries())
            },
            response => {
                responseReceived = true;
                clearTimeout(headerTimer);
                response.setTimeout(options.bodyTimeoutMs ?? timeoutMs, () => {
                    response.destroy(new HttpError(`Request timed out: ${target.pathname}`, 408, 'request_timeout'));
                });
                if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
                    void streamResponseError(response, target.pathname).then(reject, reject);
                    return;
                }
                const trailers = new Promise<IncomingHttpHeaders>((resolveTrailers, rejectTrailers) => {
                    response.once('end', () => resolveTrailers(response.trailers));
                    response.once('error', error => rejectTrailers(streamError(error, target.pathname)));
                    response.once('close', () => {
                        if (!response.complete) rejectTrailers(new HttpError(`Request failed: ${target.pathname}`, 0, 'network_error'));
                    });
                });
                void trailers.catch(() => {});
                resolve({
                    status: response.statusCode ?? 0,
                    statusText: response.statusMessage ?? '',
                    headers: response.headers,
                    body: response,
                    trailers,
                    abort: () => response.destroy(new HttpError(`Request cancelled: ${target.pathname}`, 0, 'request_cancelled'))
                });
            }
        );
        const headerTimer = setTimeout(() => {
            request.destroy(new HttpError(`Request timed out: ${target.pathname}`, 408, 'request_timeout'));
        }, timeoutMs);
        headerTimer.unref();
        request.once('error', error => {
            clearTimeout(headerTimer);
            if (!responseReceived) reject(streamError(error, target.pathname));
        });
        const body = options.body;
        if (body === undefined) request.end();
        else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
        else {
            request.destroy(new HttpError('Streaming request bodies are not supported by requestStream', 0, 'network_error'));
        }
    });
}

async function responseError(response: Response): Promise<HttpError> {
    const text = await response.text();
    return httpResponseError(response.status, response.statusText, text);
}

async function streamResponseError(response: IncomingMessage, path: string): Promise<HttpError> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
        bytes += (chunk as Buffer).length;
        if (bytes > 1024 * 1024) {
            response.destroy();
            return new HttpError(`Server returned an oversized error response from ${path}`, response.statusCode ?? 0, 'invalid_error_response');
        }
        chunks.push(Buffer.from(chunk as Buffer));
    }
    return httpResponseError(response.statusCode ?? 0, response.statusMessage ?? '', Buffer.concat(chunks).toString('utf8'));
}

function httpResponseError(status: number, statusText: string, text: string): HttpError {
    let details: unknown = text;
    let message = `${status} ${statusText}`;
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
    return new HttpError(message, status, code, details);
}

function streamError(error: unknown, path: string): HttpError {
    if (error instanceof HttpError) return error;
    return new HttpError(`Request failed: ${error instanceof Error ? error.message : String(error)}`, 0, 'network_error', { path });
}
