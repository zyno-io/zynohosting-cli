import { spawn } from 'node:child_process';

// A browser launcher that fails (no display, no handler) exits quickly with an error; one that works either returns
// success or stays running while the browser starts. Waiting this long is enough to tell the two apart.
const LAUNCH_SETTLE_MS = 1500;

export async function openUrl(url: string): Promise<void> {
    const invocation = browserInvocation(url);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore' });
        const settle = setTimeout(done, LAUNCH_SETTLE_MS);
        settle.unref();
        function done(): void {
            clearTimeout(settle);
            child.unref();
            resolve();
        }
        child.once('error', error => {
            clearTimeout(settle);
            reject(error);
        });
        child.once('exit', code => {
            clearTimeout(settle);
            if (code === 0 || code === null) done();
            else reject(new Error(`${invocation.command} exited with code ${code}`));
        });
    });
}

function browserInvocation(url: string): { command: string; args: string[] } {
    if (process.platform === 'darwin') return { command: 'open', args: [url] };
    if (process.platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    return { command: 'xdg-open', args: [url] };
}
