import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';

// Type helper for sinon stubs on the vscode mock
type StubFn = sinon.SinonStub;

suite('Extension Test Suite', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
        sinon.reset();
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

        const disposables: { dispose(): void }[] = [];
        const context = {
            subscriptions: disposables,
            globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
        } as unknown as vscode.ExtensionContext;

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

        const context = {
            subscriptions: [],
            globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
        } as unknown as vscode.ExtensionContext;
        activate(context);

        assert.ok(appendLine.called, 'appendLine should be called');
        assert.ok(
            appendLine.calledWith('Egressor extension activated'),
            'Should log "Egressor extension activated"'
        );
    });
});
