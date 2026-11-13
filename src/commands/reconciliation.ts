import type { ManagerClient } from '../api/manager-client.js';
import type { ReconciliationOperation } from '../protocol.js';

import { CliError } from '../errors.js';

export interface ReconciliationErrorCodes {
    failed: string;
    pending: string;
    /** Human noun for messages, e.g. "Site settings". */
    label: string;
}

/** Polls an accepted reconciliation until it succeeds, fails, or the deadline passes. */
export async function waitForReconciliation(
    manager: ManagerClient,
    initial: ReconciliationOperation,
    deadline: number,
    codes: ReconciliationErrorCodes,
    onUpdate: (operation: ReconciliationOperation) => void = () => {}
): Promise<ReconciliationOperation> {
    let operation = initial;
    while (operation.status !== 'succeeded') {
        if (operation.status === 'failed') {
            throw new CliError(`${codes.label} reconciliation failed: ${operation.lastError ?? 'unknown error'}`, 7, codes.failed, {
                operationId: operation.id
            });
        }
        if (Date.now() >= deadline) {
            throw new CliError(
                `${codes.label} change was accepted but is still reconciling; re-run the same command to resume waiting`,
                7,
                codes.pending,
                { operationId: operation.id, statusUrl: operation.statusUrl }
            );
        }
        operation = await manager.getReconciliation(operation.id);
        onUpdate(operation);
        if (operation.status !== 'succeeded' && operation.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return operation;
}
