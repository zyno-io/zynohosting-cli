#!/usr/bin/env node

import { createProgram } from './cli.js';
import { CliError, errorMessage } from './errors.js';
import { jsonErrorsForced } from './output.js';

try {
    await createProgram().parseAsync(process.argv);
} catch (error) {
    const json = process.argv.includes('--json') || jsonErrorsForced();
    const cliError = error instanceof CliError ? error : new CliError(errorMessage(error));
    if (json) {
        process.stderr.write(`${JSON.stringify({ type: 'error', code: cliError.code, message: cliError.message, details: cliError.details })}\n`);
    } else {
        process.stderr.write(`Error: ${cliError.message}\n`);
    }
    process.exitCode = cliError.exitCode;
}
