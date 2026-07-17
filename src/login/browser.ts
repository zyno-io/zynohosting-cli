import { spawn } from 'node:child_process';

export async function openUrl(url: string): Promise<void> {
    const invocation = browserInvocation(url);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

function browserInvocation(url: string): { command: string; args: string[] } {
    if (process.platform === 'darwin') return { command: 'open', args: [url] };
    if (process.platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    return { command: 'xdg-open', args: [url] };
}
