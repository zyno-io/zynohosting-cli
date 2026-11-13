// Preloaded for every test file (see the "test" script). Tests must not depend on the developer's or CI's shell, and
// must never be able to reach a real server through a stray variable, so remove everything that changes how login,
// credentials, or endpoints are chosen, and pretend a display exists so the browser flow is the default.
for (const name of Object.keys(process.env)) {
    if (
        name.startsWith('ZYNOHOSTING_') ||
        name.startsWith('ZYNO_') ||
        ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WAYLAND_DISPLAY', 'WSL_DISTRO_NAME'].includes(name)
    ) {
        delete process.env[name];
    }
}
process.env.DISPLAY = ':0';
// Keep any saved configuration of the person running the tests out of reach.
process.env.XDG_CONFIG_HOME = '/nonexistent-zynohosting-test-config';
process.env.APPDATA = '/nonexistent-zynohosting-test-config';
