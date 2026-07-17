import { ConfigOverrides } from '../config.js';
import { AutomationSite } from '../protocol.js';
import { managerClient } from './context.js';

export interface SiteCommandOptions extends ConfigOverrides {
    json?: boolean;
}

export async function listSites(options: SiteCommandOptions): Promise<AutomationSite[]> {
    const sites = await (await managerClient(options)).listSites();
    if (options.json) process.stdout.write(`${JSON.stringify(sites)}\n`);
    else if (!sites.length) process.stdout.write('No authorized hosting sites.\n');
    else {
        const width = Math.max(2, ...sites.map(site => site.fqdn.length));
        for (const site of sites) process.stdout.write(`${site.fqdn.padEnd(width)}  ${site.status.padEnd(12)}  ${site.id}\n`);
    }
    return sites;
}

export async function getSite(siteRef: string, options: SiteCommandOptions): Promise<AutomationSite> {
    const site = await (await managerClient(options)).getSite(siteRef);
    if (options.json) process.stdout.write(`${JSON.stringify(site)}\n`);
    else {
        process.stdout.write(`${site.fqdn}\n`);
        process.stdout.write(`ID: ${site.id}\nStatus: ${site.status}\nPHP: ${site.phpVersion ?? 'static'}\n`);
        if (site.hostnames?.length) {
            process.stdout.write('Hostnames:\n');
            for (const hostname of site.hostnames) process.stdout.write(`  ${hostname.name} (${hostname.type})\n`);
        }
    }
    return site;
}
