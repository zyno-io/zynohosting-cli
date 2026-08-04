// The delegable permissions a CLI token can carry, mirroring the Hosting and Forms keys the
// authorization page will grant. Agents guess plausible-sounding keys (`hosting.sitesWrite`), so the
// list is enumerated in the MCP schema and in `--help` instead of being validated only in the browser.
export const DELEGABLE_PERMISSION_KEYS = [
    'hosting.sitesRead',
    'hosting.filesRead',
    'hosting.filesWrite',
    'hosting.filesDelete',
    'hosting.deploy',
    'hosting.download',
    'hosting.downloadSensitive',
    'hosting.analyticsRead',
    'hosting.analyticsManage',
    'forms.create',
    'forms.edit'
] as const;

export type DelegablePermissionKey = (typeof DELEGABLE_PERMISSION_KEYS)[number];

export const PERMISSION_CAPABILITIES: Record<DelegablePermissionKey, string> = {
    'hosting.sitesRead': 'list and inspect sites (required by every hosting operation)',
    'hosting.filesRead': 'list files and read individual files',
    'hosting.filesWrite': 'create and replace individual files',
    'hosting.filesDelete': 'delete individual files',
    'hosting.deploy': 'plan and apply full deployments',
    'hosting.download': 'download the deployable snapshot',
    'hosting.downloadSensitive': 'include protected and user-generated content in a download',
    'hosting.analyticsRead': 'read hosting analytics',
    'hosting.analyticsManage': 'change analytics configuration',
    'forms.create': 'create and publish a basic form',
    'forms.edit': 'edit a form, its bot protection, and its allowed origins'
};

export const NON_DELEGABLE_PERMISSION_KEYS = new Set(['msp.login', 'msp.impersonate', 'core.changePassword', 'core.manageFingerprints']);

export const PERMISSION_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

export function isDelegablePermissionKey(value: string): value is DelegablePermissionKey {
    return (DELEGABLE_PERMISSION_KEYS as readonly string[]).includes(value);
}

/** One `key — capability` line per permission, for CLI help and tool descriptions. */
export function permissionCapabilityLines(separator = '\n'): string {
    return DELEGABLE_PERMISSION_KEYS.map(key => `${key} — ${PERMISSION_CAPABILITIES[key]}`).join(separator);
}

/** The closest valid key to a rejected one, so a wrong guess names its likely replacement. */
export function suggestPermissionKey(value: string): DelegablePermissionKey | undefined {
    const candidate = value.trim().toLowerCase();
    let best: DelegablePermissionKey | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const key of DELEGABLE_PERMISSION_KEYS) {
        const distance = editDistance(candidate, key.toLowerCase());
        if (distance < bestDistance) {
            best = key;
            bestDistance = distance;
        }
    }
    return bestDistance <= 6 ? best : undefined;
}

function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
        }
        previous = current;
    }
    return previous[b.length] ?? Number.POSITIVE_INFINITY;
}
