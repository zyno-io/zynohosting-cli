import { CliError } from '../errors.js';
import { FileDeleteResult, FileListResponse, FilePutResult, parseFileDeleteResult, parseFileList, parseFilePutResult } from '../protocol.js';
import { request, requestJson, requestStream, StreamingResponse } from './http.js';

export class FileClient {
    private readonly baseUrl: string;

    constructor(
        baseUrl: string,
        private readonly token: string,
        private readonly timeoutMs = 600_000
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    async list(path = '', recursive = false): Promise<FileListResponse> {
        const url = this.url('/entries', { path, recursive: recursive ? 'true' : 'false' });
        const result = parseFileList(
            await requestJson(url, {
                headers: this.headers(),
                timeoutMs: this.timeoutMs
            })
        );
        if (result.path !== path || result.recursive !== recursive) {
            throw new CliError('Agent returned a mismatched file listing', 5, 'invalid_agent_response');
        }
        return result;
    }

    get(path: string): Promise<Response> {
        return request(this.url('/content', { path }), {
            headers: this.headers({ Accept: 'application/octet-stream' }),
            timeoutMs: this.timeoutMs
        });
    }

    async put(path: string, content: NodeJS.ReadableStream, precondition: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<FilePutResult> {
        const result = parseFilePutResult(
            await requestJson(this.url('/content', { path }), {
                method: 'PUT',
                headers: this.headers({
                    'Content-Type': 'application/octet-stream',
                    ...(precondition.ifMatch ? { 'If-Match': precondition.ifMatch } : {}),
                    ...(precondition.ifNoneMatch ? { 'If-None-Match': precondition.ifNoneMatch } : {})
                }),
                body: content,
                timeoutMs: this.timeoutMs
            })
        );
        if (result.entry.path !== path) throw new CliError('Agent returned a mismatched uploaded file path', 5, 'invalid_agent_response');
        return result;
    }

    async delete(path: string, ifMatch?: string): Promise<FileDeleteResult> {
        const result = parseFileDeleteResult(
            await requestJson(this.url('/content', { path }), {
                method: 'DELETE',
                headers: this.headers(ifMatch ? { 'If-Match': ifMatch } : {}),
                timeoutMs: this.timeoutMs
            })
        );
        if (result.path !== path) throw new CliError('Agent returned a mismatched deleted file path', 5, 'invalid_agent_response');
        return result;
    }

    async archive(scope: 'deployable' | 'sensitive'): Promise<StreamingResponse> {
        const body = JSON.stringify({ scope });
        const response = await requestStream(`${this.baseUrl}/archives`, {
            method: 'POST',
            headers: this.headers({
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(body)),
                Accept: 'application/gzip',
                Connection: 'TE',
                TE: 'trailers'
            }),
            body,
            timeoutMs: Math.max(this.timeoutMs, 45 * 60_000),
            bodyTimeoutMs: this.timeoutMs
        });
        if (responseHeader(response, 'x-zh-archive-scope') !== scope) {
            response.abort();
            throw new CliError('Agent returned a mismatched archive scope', 5, 'invalid_agent_response');
        }
        if (!responseHeader(response, 'content-type')?.toLowerCase().startsWith('application/gzip')) {
            response.abort();
            throw new CliError('Agent returned an invalid archive content type', 5, 'invalid_agent_response');
        }
        return response;
    }

    private url(path: string, query: Record<string, string>): string {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        return url.toString();
    }

    private headers(additional: Record<string, string> = {}): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...additional
        };
    }
}

export function responseHeader(response: Pick<StreamingResponse, 'headers'>, name: string): string | undefined {
    const value = response.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}
