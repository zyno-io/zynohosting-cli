import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseLoginFlow } from '../src/login/flow.js';

const linux = 'linux' as const;

test('explicit choices always win', () => {
    assert.deepEqual(chooseLoginFlow(true, {}, 'darwin'), { flow: 'device', reason: 'explicit' });
    assert.deepEqual(chooseLoginFlow(false, { SSH_CONNECTION: '1 2 3 4' }, linux), { flow: 'browser', reason: 'explicit' });
});

test('any SSH variable chooses the device flow, even where a display exists', () => {
    for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
        assert.deepEqual(chooseLoginFlow(undefined, { [name]: 'x', DISPLAY: ':0' }, linux), { flow: 'device', reason: 'ssh' });
        assert.deepEqual(chooseLoginFlow(undefined, { [name]: 'x' }, 'darwin'), { flow: 'device', reason: 'ssh' });
    }
});

test('a Linux machine with no display chooses the device flow', () => {
    assert.deepEqual(chooseLoginFlow(undefined, {}, linux), { flow: 'device', reason: 'no_display' });
    assert.deepEqual(chooseLoginFlow(undefined, { DISPLAY: '', WAYLAND_DISPLAY: '' }, linux), { flow: 'device', reason: 'no_display' });
    assert.deepEqual(chooseLoginFlow(undefined, { DISPLAY: ':0' }, linux), { flow: 'browser', reason: 'default' });
    assert.deepEqual(chooseLoginFlow(undefined, { WAYLAND_DISPLAY: 'wayland-0' }, linux), { flow: 'browser', reason: 'default' });
});

test('WSL, macOS and Windows use the browser without a display variable', () => {
    assert.deepEqual(chooseLoginFlow(undefined, { WSL_DISTRO_NAME: 'Ubuntu' }, linux), { flow: 'browser', reason: 'default' });
    assert.deepEqual(chooseLoginFlow(undefined, {}, 'darwin'), { flow: 'browser', reason: 'default' });
    assert.deepEqual(chooseLoginFlow(undefined, {}, 'win32'), { flow: 'browser', reason: 'default' });
});
