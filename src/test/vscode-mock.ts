// Mock for the vscode module used in unit tests
import * as sinon from 'sinon';

const disposable = { dispose: () => {} };

function createMockStatusBarItem() {
    return {
        text: '',
        tooltip: '',
        command: undefined as string | undefined,
        backgroundColor: undefined as unknown,
        show: sinon.stub(),
        hide: sinon.stub(),
        dispose: sinon.stub(),
    };
}

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
    registerWebviewViewProvider: sinon.stub().returns(disposable),
    createStatusBarItem: sinon.stub().callsFake(() => createMockStatusBarItem()),
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
    file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => p }),
    parse: (uri: string) => ({ scheme: 'file', fsPath: uri, path: uri, toString: () => uri }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => {
        const joined = [base.fsPath, ...segments].join('/');
        return { scheme: 'file', fsPath: joined, path: joined, toString: () => joined };
    },
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

const Range = class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
    }
};

const Diagnostic = class {
    range: InstanceType<typeof Range>;
    message: string;
    severity: number;
    source?: string;
    constructor(range: InstanceType<typeof Range>, message: string, severity?: number) {
        this.range = range;
        this.message = message;
        this.severity = severity ?? 0;
    }
};

const ThemeColor = class {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
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
    Range,
    Diagnostic,
    ThemeColor,
    RelativePattern,
    resetMocks,
};
