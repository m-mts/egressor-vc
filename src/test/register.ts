// Register vscode mock before any tests import vscode
// This file is compiled to JS and runs as CommonJS in mocha
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
    if (request === 'vscode') {
        return require.resolve(path.resolve(__dirname, 'vscode-mock'));
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
