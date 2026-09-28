#!/usr/bin/env node
require('@hydrooj/register');
require('../exam-cli.ts').main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
