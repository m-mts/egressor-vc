// Mock for the vscode module used in unit tests
import * as sinon from 'sinon';

const disposable = { dispose: () => {} };

const window = {
    createOutputChannel: sinon.stub().returns({
        appendLine: sinon.stub(),
        dispose: sinon.stub(),
        show: sinon.stub(),
        clear: sinon.stub()
    }),
    showInformationMessage: sinon.stub().resolves(undefined),
    showWarningMessage: sinon.stub().resolves(undefined),
    showErrorMessage: sinon.stub().resolves(undefined),
    showInputBox: sinon.stub().resolves(undefined),
    showQuickPick: sinon.stub().resolves(undefined),
};

const commands = {
    registerCommand: sinon.stub().returns(disposable),
    executeCommand: sinon.stub().resolves(undefined),
};

const workspace = {
    getConfiguration: sinon.stub().returns({
        get: sinon.stub(),
        update: sinon.stub().resolves(),
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: sinon.stub().returns(disposable),
    createFileSystemWatcher: sinon.stub().returns({
        onDidChange: sinon.stub().returns(disposable),
        onDidCreate: sinon.stub().returns(disposable),
        onDidDelete: sinon.stub().returns(disposable),
        dispose: sinon.stub(),
    }),
    fs: {
        readFile: sinon.stub().resolves(Buffer.from('')),
        writeFile: sinon.stub().resolves(),
    },
};

const Uri = {
    file: (path: string) => ({ scheme: 'file', fsPath: path, path }),
    parse: (uri: string) => ({ scheme: 'file', fsPath: uri, path: uri }),
};

const EventEmitter = class {
    event = sinon.stub();
    fire = sinon.stub();
    dispose = sinon.stub();
};

const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
};

const StatusBarAlignment = {
    Left: 1,
    Right: 2,
};

const languages = {
    createDiagnosticCollection: sinon.stub().returns({
        set: sinon.stub(),
        delete: sinon.stub(),
        clear: sinon.stub(),
        dispose: sinon.stub(),
    }),
};

const RelativePattern = class {
    base: string;
    pattern: string;
    constructor(base: string, pattern: string) {
        this.base = base;
        this.pattern = pattern;
    }
};

export function resetMocks(): void {
    sinon.reset();
}

module.exports = {
    window,
    commands,
    workspace,
    Uri,
    EventEmitter,
    DiagnosticSeverity,
    StatusBarAlignment,
    languages,
    RelativePattern,
    resetMocks,
};
