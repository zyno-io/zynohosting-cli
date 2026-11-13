export type LoginFlow = 'browser' | 'device';

export type LoginFlowReason = 'explicit' | 'ssh' | 'no_display' | 'default' | 'loopback_unavailable';

export interface LoginFlowChoice {
    flow: LoginFlow;
    reason: LoginFlowReason;
}

/**
 * Picks how to sign in. Device sign-in (a link and a code the person opens on any device) is chosen only where the
 * browser flow cannot work: over SSH, or on a machine with no display. There is no fallback from device to browser.
 */
export function chooseLoginFlow(explicit: boolean | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): LoginFlowChoice {
    if (explicit === true) return { flow: 'device', reason: 'explicit' };
    if (explicit === false) return { flow: 'browser', reason: 'explicit' };
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { flow: 'device', reason: 'ssh' };
    if (platform !== 'darwin' && platform !== 'win32' && !env.WSL_DISTRO_NAME && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
        return { flow: 'device', reason: 'no_display' };
    }
    return { flow: 'browser', reason: 'default' };
}
