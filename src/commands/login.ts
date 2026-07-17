import { configPath, HostingEnvironment, loadStoredConfig, normalizeApiUrl, resolveApiUrl, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { openUrl } from '../login/browser.js';
import { startLoopbackLogin } from '../login/loopback.js';

const DEFAULT_ALPHA_LOGIN_URL = 'https://zyno.dev/cli/login';
const DEFAULT_DEV_LOGIN_URL = 'http://localhost:5173/cli/login';
const DEFAULT_PRODUCTION_LOGIN_URL = 'https://zyno.app/cli/login';

export interface LoginOptions {
    apiUrl?: string;
    environment?: HostingEnvironment;
    apiKey?: string;
    loginUrl?: string;
    timeoutSeconds?: number;
    open?: boolean;
}

export interface LoginDependencies {
    env?: NodeJS.ProcessEnv;
    configFile?: string;
    openUrl?: (url: string) => Promise<void>;
    write?: (message: string) => void;
}

export async function login(options: LoginOptions, dependencies: LoginDependencies = {}): Promise<void> {
    const env = dependencies.env ?? process.env;
    const file = dependencies.configFile ?? configPath(env);
    const stored = await loadStoredConfig(file);
    const apiUrl = resolveApiUrl(options.apiUrl, stored, env, options.environment);
    const apiKey = options.apiKey ?? env.ZYNO_HOSTING_API_KEY;
    const write = dependencies.write ?? (message => process.stdout.write(message));

    if (apiKey) {
        await saveConfig({ apiUrl, apiKey }, file);
        write('ZynoHosting API-key credentials saved.\n');
        return;
    }

    const loginPageUrl = resolveLoginPageUrl(options.loginUrl ?? env.ZYNO_HOSTING_LOGIN_URL, apiUrl);
    const loopback = await startLoopbackLogin({ timeoutMs: Math.max(1, options.timeoutSeconds ?? 300) * 1000 });
    const browserUrl = new URL(loginPageUrl);
    browserUrl.searchParams.set('callback', loopback.callbackUrl);
    browserUrl.searchParams.set('state', loopback.state);
    browserUrl.searchParams.set('apiUrl', apiUrl);

    write('Opening your browser to sign in to Zyno…\n');
    if (options.open === false) {
        write(`Open this URL to continue:\n${browserUrl.toString()}\n`);
    } else {
        try {
            await (dependencies.openUrl ?? openUrl)(browserUrl.toString());
        } catch {
            write(`The browser could not be opened automatically. Open this URL to continue:\n${browserUrl.toString()}\n`);
        }
    }

    try {
        const credential = await loopback.result;
        await saveConfig(
            {
                apiUrl,
                accessToken: credential.accessToken,
                tenantId: credential.tenantId,
                expiresAt: credential.expiresAt
            },
            file
        );
        write('ZynoHosting login complete.\n');
    } finally {
        await loopback.close();
    }
}

export function resolveLoginPageUrl(value: string | undefined, apiUrl: string): string {
    const normalized = normalizeApiUrl(value ?? defaultLoginPageUrl(apiUrl));
    const url = new URL(normalized);
    if (url.hash) throw new CliError('The SPA login URL cannot contain a fragment', 2, 'invalid_login_url');
    return normalized;
}

function defaultLoginPageUrl(apiUrl: string): string {
    const hostname = new URL(apiUrl).hostname;
    if (hostname === 'hosting.api-alpha.zyno.dev') return DEFAULT_ALPHA_LOGIN_URL;
    if (hostname === 'hosting.api.zyno.app') return DEFAULT_PRODUCTION_LOGIN_URL;
    if (new Set(['localhost', '127.0.0.1', '[::1]']).has(hostname)) return DEFAULT_DEV_LOGIN_URL;
    throw new CliError(
        'The SPA login URL is not configured for this Hosting API. Pass --login-url or set ZYNO_HOSTING_LOGIN_URL.',
        2,
        'missing_login_url'
    );
}
