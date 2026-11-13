// A 403 from the API says what is forbidden but not that the login itself was approved with fewer permissions than were
// asked for. The HTTP layer sees only the request headers, so the access tokens of logins with denied permissions are
// remembered here and a 403 for one of them gets a hint. This never guesses which permission a command needs.
const deniedByToken = new Map<string, string[]>();
const MAX_REMEMBERED = 64;

export function rememberDeniedPermissions(accessToken: string, deniedPermissionKeys: readonly string[] | undefined): void {
    if (!deniedPermissionKeys?.length) return;
    if (deniedByToken.size >= MAX_REMEMBERED) deniedByToken.clear();
    deniedByToken.set(accessToken, [...deniedPermissionKeys]);
}

/** Text to append to a 403 message when the request's bearer token belongs to a login that was not granted everything. */
export function permissionDeniedHint(authorization: string | null | undefined): string {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const denied = token ? deniedByToken.get(token) : undefined;
    if (!denied?.length) return '';
    return ` This login was not granted ${denied.join(', ')} when it was approved. If this action needs ${denied.length > 1 ? 'one of them' : 'it'}, sign in again as someone who has ${denied.length > 1 ? 'them' : 'it'}.`;
}
