import { ManagerClient } from '../api/manager-client.js';
import { ConfigOverrides, resolveConfig } from '../config.js';

export async function managerClient(options: ConfigOverrides, timeoutMs = 30_000): Promise<ManagerClient> {
    const config = await resolveConfig(options);
    return new ManagerClient(config.apiUrl, config.credential, timeoutMs);
}
