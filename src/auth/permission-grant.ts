export interface PermissionGrant {
    /** What the approver granted: a non-empty subset of what was requested. */
    granted: string[];
    /** What was requested but not granted (the approver does not hold it in that tenant). */
    denied: string[];
}

/**
 * Works out what a credential actually carries. An older server or portal says nothing about permissions, which means
 * everything requested was granted. Otherwise the granted keys must be a non-empty subset of the requested ones, and any
 * denied keys must have been requested. Returns undefined for a response that breaks those rules.
 */
export function resolvePermissionGrant(
    requested: readonly string[],
    granted: readonly string[] | undefined,
    denied: readonly string[] | undefined
): PermissionGrant | undefined {
    const asked = new Set(requested);
    if (denied?.some(key => !asked.has(key))) return undefined;
    let carried: string[];
    if (granted) {
        if (granted.some(key => !asked.has(key))) return undefined;
        carried = requested.filter(key => granted.includes(key));
    } else {
        carried = requested.filter(key => !denied?.includes(key));
    }
    if (carried.length === 0) return undefined;
    return { granted: carried, denied: requested.filter(key => !carried.includes(key)) };
}
