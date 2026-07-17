import { DeploymentOperation, InventoryFile, OperationKind } from '../protocol.js';

export interface DisplayOperation {
    kind: OperationKind;
    path: string;
    directory: boolean;
    fileCount: number;
    bytes: number;
}

type LeafStatus = OperationKind | 'unchanged';

interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    status?: LeafStatus;
    bytes: number;
}

interface Analysis {
    uniform?: OperationKind;
    operationKinds: Set<OperationKind>;
    hasUnchanged: boolean;
    fileCount: number;
    bytes: number;
}

export function coalesceOperations(files: readonly InventoryFile[], operations: readonly DeploymentOperation[]): DisplayOperation[] {
    const operationByPath = new Map(operations.map(operation => [operation.path, operation]));
    const localPaths = new Set(files.map(file => file.path));
    const root: TreeNode = { name: '', children: new Map(), bytes: 0 };
    for (const file of files) {
        const operation = operationByPath.get(file.path);
        insert(root, file.path, operation?.kind ?? 'unchanged', operationBytes(operation, file.size));
    }
    for (const operation of operations) {
        if (localPaths.has(operation.path)) continue;
        insert(root, operation.path, operation.kind, operationBytes(operation, 0));
    }

    const output: DisplayOperation[] = [];
    emit(root, '', true, output);
    return output.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

function insert(root: TreeNode, path: string, status: LeafStatus, bytes: number): void {
    const components = path.split('/');
    let node = root;
    for (const component of components) {
        let child = node.children.get(component);
        if (!child) {
            child = { name: component, children: new Map(), bytes: 0 };
            node.children.set(component, child);
        }
        node = child;
    }
    node.status = status;
    node.bytes = bytes;
}

function emit(node: TreeNode, parentPath: string, isRoot: boolean, output: DisplayOperation[]): Analysis {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    const childAnalyses = [...node.children.values()].map(child => emit(child, path, false, output));
    const ownStatus = node.status;
    const hasUnchanged = ownStatus === 'unchanged' || childAnalyses.some(child => child.hasUnchanged);
    const operationKinds = new Set<OperationKind>();
    if (ownStatus && ownStatus !== 'unchanged') operationKinds.add(ownStatus);
    for (const child of childAnalyses) {
        for (const kind of child.operationKinds) operationKinds.add(kind);
    }
    const fileCount = (ownStatus ? 1 : 0) + childAnalyses.reduce((total, child) => total + child.fileCount, 0);
    const bytes = (ownStatus ? node.bytes : 0) + childAnalyses.reduce((total, child) => total + child.bytes, 0);
    const uniform = !hasUnchanged && operationKinds.size === 1 ? [...operationKinds][0] : undefined;

    if (!isRoot && node.children.size > 0 && uniform && fileCount > 1) {
        removeDescendants(output, `${path}/`);
        output.push({ kind: uniform, path: `${path}/`, directory: true, fileCount, bytes });
    } else if (ownStatus && ownStatus !== 'unchanged') {
        output.push({ kind: ownStatus, path, directory: false, fileCount: 1, bytes: node.bytes });
    }

    return { ...(uniform ? { uniform } : {}), operationKinds, hasUnchanged, fileCount, bytes };
}

function removeDescendants(output: DisplayOperation[], prefix: string): void {
    for (let index = output.length - 1; index >= 0; index--) {
        if (output[index]!.path.startsWith(prefix)) output.splice(index, 1);
    }
}

function operationBytes(operation: DeploymentOperation | undefined, fallback: number): number {
    if (!operation) return fallback;
    if (operation.kind === 'delete') return operation.previousSize ?? operation.size ?? fallback;
    return operation.size ?? fallback;
}
