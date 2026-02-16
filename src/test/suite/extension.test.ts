import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';

// Type helper for sinon stubs on the vscode mock
type StubFn = sinon.SinonStub;

function ensureVscodeMocks(sandbox: sinon.SinonSandbox): void {
    const createSBI = vscode.window.createStatusBarItem as unknown as sinon.SinonStub;
    if (createSBI && typeof createSBI.callsFake === 'function') {
        createSBI.callsFake(() => ({
            text: '',
            tooltip: '',
            command: undefined as string | undefined,
            backgroundColor: undefined as unknown,
            show: sandbox.stub(),
            hide: sandbox.stub(),
            dispose: sandbox.stub(),
        }));
    }
    const createDC = vscode.languages.createDiagnosticCollection as unknown as sinon.SinonStub;
    if (createDC && typeof createDC.returns === 'function') {
        createDC.returns({
            set: sandbox.stub(),
            delete: sandbox.stub(),
            clear: sandbox.stub(),
            dispose: sandbox.stub(),
        });
    }
    const regWV = vscode.window.registerWebviewViewProvider as unknown as sinon.SinonStub;
    if (regWV && typeof regWV.returns === 'function') {
        regWV.returns({ dispose: sandbox.stub() });
    }
}

function createMockContext(sandbox: sinon.SinonSandbox): vscode.ExtensionContext {
    return {
        subscriptions: [],
        globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
        extensionUri: vscode.Uri.file('/tmp/egressor-extension'),
        secrets: {
            get: sandbox.stub().resolves(undefined),
            store: sandbox.stub().resolves(),
            delete: sandbox.stub().resolves(),
            onDidChange: sandbox.stub(),
        },
        globalState: {
            get: sandbox.stub().returns([]),
            update: sandbox.stub().resolves(),
        },
    } as unknown as vscode.ExtensionContext;
}

suite('Extension Test Suite', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        ensureVscodeMocks(sandbox);
    });

    teardown(() => {
        deactivate();
        sandbox.restore();
    });

    test('activate creates output channel and registers commands', () => {
        const fakeOutputChannel = {
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
        };
        const fakeDisposable = { dispose: sandbox.stub() };

        (vscode.window.createOutputChannel as unknown as StubFn).returns(fakeOutputChannel);
        (vscode.commands.registerCommand as unknown as StubFn).returns(fakeDisposable);

        const context = createMockContext(sandbox);

        activate(context);

        const createOutput = vscode.window.createOutputChannel as unknown as StubFn;
        assert.ok(createOutput.calledOnce, 'Should create one output channel');
        assert.strictEqual(
            createOutput.firstCall.args[0],
            'Egressor',
            'Output channel should be named Egressor'
        );

        assert.ok(
            fakeOutputChannel.appendLine.calledWith('Egressor extension activated'),
            'Should log activation message'
        );

        const registerCmd = vscode.commands.registerCommand as unknown as StubFn;
        assert.ok(registerCmd.callCount >= 2, 'Should register at least 2 commands');
        const commandNames = registerCmd.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
        assert.ok(commandNames.includes('egressor.start'), 'Should register egressor.start');
        assert.ok(commandNames.includes('egressor.stop'), 'Should register egressor.stop');

        const disposables = context.subscriptions;
        assert.ok(disposables.length >= 5, `Expected at least 5 disposables, got ${disposables.length}`);
    });

    test('deactivate does not throw', () => {
        assert.doesNotThrow(() => deactivate());
    });

    test('activate logs activation message to output channel', () => {
        const appendLine = sandbox.stub();
        (vscode.window.createOutputChannel as unknown as StubFn).returns({
            appendLine,
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
        });
        (vscode.commands.registerCommand as unknown as StubFn).returns({ dispose: sandbox.stub() });

        const context = createMockContext(sandbox);
        activate(context);

        assert.ok(appendLine.called, 'appendLine should be called');
        assert.ok(
            appendLine.calledWith('Egressor extension activated'),
            'Should log "Egressor extension activated"'
        );
    });
});
