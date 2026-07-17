export class CliError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
        readonly code = 'cli_error',
        readonly details?: unknown
    ) {
        super(message);
        this.name = 'CliError';
    }
}

export class HttpError extends CliError {
    constructor(
        message: string,
        readonly status: number,
        code = 'http_error',
        details?: unknown
    ) {
        super(message, status === 401 || status === 403 ? 3 : 4, code, details);
        this.name = 'HttpError';
    }
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
