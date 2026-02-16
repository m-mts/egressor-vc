import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { parseBrokerLogLine, createBrokerStreamParser } from '../../secrets/broker-events';
import { SecretlessBrokerManager, ProcessSpawner, FileSystemOps } from '../../secrets/broker-manager';
import { CredentialProvider, SecretStorageApi, GlobalStateApi } from '../../secrets/credential-provider';
import { promptForSecret, promptForMissingSecrets, WindowApi } from '../../secrets/prompt';
import { SecretInjectionEvent } from '../../secrets/types';
import { SecretDeclaration } from '../../config/types';

// --- Broker Event Parsing Tests ---

suite('Secretless Broker Event Parsing', () => {
    test('parses INJECT bearer_token SUCCESS', () => {
        const event = parseBrokerLogLine('INJECT bearer_token my-api-token api.example.com SUCCESS');
        assert.ok(event);
        assert.strictEqual(event!.secretName, 'my-api-token');
        assert.strictEqual(event!.secretType, 'bearer_token');
        assert.strictEqual(event!.target, 'api.example.com');
        assert.strictEqual(event!.success, true);
    });

    test('parses INJECT postgresql SUCCESS', () => {
        const event = parseBrokerLogLine('INJECT postgresql my-db db.example.com:5432 SUCCESS');
        assert.ok(event);
        assert.strictEqual(event!.secretName, 'my-db');
        assert.strictEqual(event!.secretType, 'postgresql');
        assert.strictEqual(event!.target, 'db.example.com:5432');
        assert.strictEqual(event!.success, true);
    });

    test('parses INJECT FAILED', () => {
        const event = parseBrokerLogLine('INJECT basic_auth my-creds api.internal.com FAILED');
        assert.ok(event);
        assert.strictEqual(event!.secretName, 'my-creds');
        assert.strictEqual(event!.secretType, 'basic_auth');
        assert.strictEqual(event!.success, false);
    });

    test('parses CONNECT event', () => {
        const event = parseBrokerLogLine('CONNECT my-db-service postgresql db.example.com:5432');
        assert.ok(event);
        assert.strictEqual(event!.secretName, 'my-db-service');
        assert.strictEqual(event!.secretType, 'postgresql');
        assert.strictEqual(event!.target, 'db.example.com:5432');
        assert.strictEqual(event!.success, true);
    });

    test('returns undefined for empty line', () => {
        assert.strictEqual(parseBrokerLogLine(''), undefined);
        assert.strictEqual(parseBrokerLogLine('   '), undefined);
    });

    test('returns undefined for unrecognized line', () => {
        assert.strictEqual(parseBrokerLogLine('secretless-broker starting'), undefined);
        assert.strictEqual(parseBrokerLogLine('listening on port 8080'), undefined);
    });

    test('returns undefined for invalid secret type', () => {
        assert.strictEqual(parseBrokerLogLine('INJECT unknown_type foo bar SUCCESS'), undefined);
    });
});

suite('Secretless Broker Stream Parser', () => {
    test('emits events for complete lines', () => {
        const events: SecretInjectionEvent[] = [];
        const parser = createBrokerStreamParser(e => events.push(e));

        parser.push('INJECT bearer_token my-token api.com SUCCESS\n');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].secretName, 'my-token');
    });

    test('buffers partial lines', () => {
        const events: SecretInjectionEvent[] = [];
        const parser = createBrokerStreamParser(e => events.push(e));

        parser.push('INJECT bearer_token');
        assert.strictEqual(events.length, 0);

        parser.push(' my-token api.com SUCCESS\n');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].secretName, 'my-token');
    });

    test('handles multiple lines in one chunk', () => {
        const events: SecretInjectionEvent[] = [];
        const parser = createBrokerStreamParser(e => events.push(e));

        parser.push('INJECT bearer_token t1 a.com SUCCESS\nINJECT mysql db1 b.com:3306 SUCCESS\n');
        assert.strictEqual(events.length, 2);
    });

    test('flush processes remaining buffer', () => {
        const events: SecretInjectionEvent[] = [];
        const parser = createBrokerStreamParser(e => events.push(e));

        parser.push('CONNECT my-svc postgresql db.com:5432');
        assert.strictEqual(events.length, 0);

        parser.flush();
        assert.strictEqual(events.length, 1);
    });

    test('flush with empty buffer does nothing', () => {
        const events: SecretInjectionEvent[] = [];
        const parser = createBrokerStreamParser(e => events.push(e));
        parser.flush();
        assert.strictEqual(events.length, 0);
    });
});

// --- Broker Manager Tests ---

suite('SecretlessBrokerManager', () => {
    function createMockOutputChannel(): { appendLine: sinon.SinonStub } {
        return { appendLine: sinon.stub() };
    }

    function createMockProcess(): EventEmitter & {
        pid: number;
        killed: boolean;
        kill: sinon.SinonStub;
        stdout: EventEmitter;
        stderr: EventEmitter;
    } {
        const proc = new EventEmitter() as EventEmitter & {
            pid: number;
            killed: boolean;
            kill: sinon.SinonStub;
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        proc.pid = 54321;
        proc.killed = false;
        proc.kill = sinon.stub().callsFake(() => {
            proc.killed = true;
            setTimeout(() => proc.emit('exit', 0, null), 10);
        });
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        return proc;
    }

    function createMockFsOps(): FileSystemOps & {
        existsSyncStub: sinon.SinonStub;
        mkdirSyncStub: sinon.SinonStub;
        writeFileSyncStub: sinon.SinonStub;
        unlinkSyncStub: sinon.SinonStub;
    } {
        const existsSyncStub = sinon.stub().returns(false);
        const mkdirSyncStub = sinon.stub();
        const writeFileSyncStub = sinon.stub();
        const unlinkSyncStub = sinon.stub();
        return {
            existsSync: existsSyncStub,
            mkdirSync: mkdirSyncStub,
            writeFileSync: writeFileSyncStub,
            unlinkSync: unlinkSyncStub,
            existsSyncStub,
            mkdirSyncStub,
            writeFileSyncStub,
            unlinkSyncStub,
        };
    }

    test('initial state is stopped', () => {
        const output = createMockOutputChannel();
        const manager = new SecretlessBrokerManager(output as unknown as vscode.OutputChannel);
        assert.strictEqual(manager.getState(), 'stopped');
        manager.dispose();
    });

    test('healthCheck returns correct status when stopped', () => {
        const output = createMockOutputChannel();
        const manager = new SecretlessBrokerManager(output as unknown as vscode.OutputChannel);
        const health = manager.healthCheck();
        assert.strictEqual(health.alive, false);
        assert.strictEqual(health.state, 'stopped');
        assert.strictEqual(health.pid, undefined);
        manager.dispose();
    });

    test('start succeeds and transitions to running', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        const result = await manager.start({
            configFilePath: '/tmp/secretless.yml',
            secretsDir: '/tmp/secrets',
        });

        assert.ok(result);
        assert.strictEqual(manager.getState(), 'running');

        const health = manager.healthCheck();
        assert.ok(health.alive);
        assert.strictEqual(health.pid, 54321);

        manager.dispose();
    });

    test('start builds correct args', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawnStub = sinon.stub().returns(mockProc);
        const spawner: ProcessSpawner = { spawn: spawnStub };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({
            configFilePath: '/tmp/secretless.yml',
            secretsDir: '/tmp/secrets',
            healthCheckPort: 5335,
        });

        const args = spawnStub.firstCall.args[1];
        assert.ok(args.includes('-f'));
        assert.ok(args.includes('/tmp/secretless.yml'));
        assert.ok(args.includes('-p'));
        assert.ok(args.includes('5335'));

        manager.dispose();
    });

    test('start returns true if already running', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });
        const result = await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });
        assert.ok(result);

        manager.dispose();
    });

    test('stop transitions to stopped state', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });
        assert.strictEqual(manager.getState(), 'running');

        await manager.stop();
        assert.strictEqual(manager.getState(), 'stopped');
        assert.ok(!manager.healthCheck().alive);

        manager.dispose();
    });

    test('stop is safe when already stopped', async () => {
        const output = createMockOutputChannel();
        const manager = new SecretlessBrokerManager(output as unknown as vscode.OutputChannel);
        await manager.stop();
        assert.strictEqual(manager.getState(), 'stopped');
        manager.dispose();
    });

    test('restart stops and starts with same options', async () => {
        const output = createMockOutputChannel();
        const mockProc1 = createMockProcess();
        const mockProc2 = createMockProcess();
        const spawnStub = sinon.stub()
            .onFirstCall().returns(mockProc1)
            .onSecondCall().returns(mockProc2);
        const spawner: ProcessSpawner = { spawn: spawnStub };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });
        const result = await manager.restart();

        assert.ok(result);
        assert.strictEqual(manager.getState(), 'running');
        assert.ok(spawnStub.calledTwice);

        manager.dispose();
    });

    test('restart fails when no previous options', async () => {
        const output = createMockOutputChannel();
        const manager = new SecretlessBrokerManager(output as unknown as vscode.OutputChannel);
        const result = await manager.restart();

        assert.ok(!result);
        assert.strictEqual(manager.getState(), 'error');

        manager.dispose();
    });

    test('emits injection events from stdout', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        const events: SecretInjectionEvent[] = [];
        manager.onSecretInjection(e => events.push(e));

        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        mockProc.stdout.emit('data', Buffer.from('INJECT bearer_token my-token api.com SUCCESS\n'));
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].secretName, 'my-token');
        assert.strictEqual(events[0].success, true);

        manager.dispose();
    });

    test('emits injection events from stderr', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        const events: SecretInjectionEvent[] = [];
        manager.onSecretInjection(e => events.push(e));

        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        mockProc.stderr.emit('data', Buffer.from('INJECT mysql my-db db.com:3306 FAILED\n'));
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].success, false);

        manager.dispose();
    });

    test('listener disposal works', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        const events: SecretInjectionEvent[] = [];
        const disposable = manager.onSecretInjection(e => events.push(e));

        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        mockProc.stdout.emit('data', Buffer.from('INJECT bearer_token t1 a.com SUCCESS\n'));
        assert.strictEqual(events.length, 1);

        disposable.dispose();

        mockProc.stdout.emit('data', Buffer.from('INJECT bearer_token t2 b.com SUCCESS\n'));
        assert.strictEqual(events.length, 1, 'Should not receive events after disposal');

        manager.dispose();
    });

    test('handles unexpected process exit', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        mockProc.kill = sinon.stub();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        mockProc.emit('exit', 1, null);
        assert.strictEqual(manager.getState(), 'error');

        const health = manager.healthCheck();
        assert.ok(health.error);
        assert.ok(health.error!.includes('exited unexpectedly'));

        manager.dispose();
    });

    test('handles process error event', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        mockProc.kill = sinon.stub();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        mockProc.emit('error', new Error('spawn ENOENT'));
        assert.strictEqual(manager.getState(), 'error');
        assert.strictEqual(manager.healthCheck().error, 'spawn ENOENT');

        manager.dispose();
    });

    test('writeSecretFiles creates directory and writes files', () => {
        const output = createMockOutputChannel();
        const fsOps = createMockFsOps();

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            undefined,
            fsOps
        );

        manager.writeSecretFiles('/tmp/secrets', {
            'my-token': 'secret-value',
            'my-db_username': 'admin',
        });

        assert.ok(fsOps.mkdirSyncStub.calledOnce);
        assert.strictEqual(fsOps.mkdirSyncStub.firstCall.args[0], '/tmp/secrets');
        assert.strictEqual(fsOps.writeFileSyncStub.callCount, 2);
        assert.strictEqual(fsOps.writeFileSyncStub.firstCall.args[0], '/tmp/secrets/my-token');
        assert.strictEqual(fsOps.writeFileSyncStub.firstCall.args[1], 'secret-value');

        manager.dispose();
    });

    test('writeSecretFiles skips mkdir if directory exists', () => {
        const output = createMockOutputChannel();
        const fsOps = createMockFsOps();
        fsOps.existsSyncStub.returns(true);

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            undefined,
            fsOps
        );

        manager.writeSecretFiles('/tmp/secrets', { 'token': 'val' });

        assert.ok(fsOps.mkdirSyncStub.notCalled);
        assert.strictEqual(fsOps.writeFileSyncStub.callCount, 1);

        manager.dispose();
    });

    test('removeSecretFiles removes existing files', () => {
        const output = createMockOutputChannel();
        const fsOps = createMockFsOps();
        fsOps.existsSyncStub.callsFake((p: string) => p.includes('my-token'));

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            undefined,
            fsOps
        );

        manager.removeSecretFiles('/tmp/secrets', ['my-token', 'nonexistent']);

        assert.strictEqual(fsOps.unlinkSyncStub.callCount, 1);
        assert.strictEqual(fsOps.unlinkSyncStub.firstCall.args[0], '/tmp/secrets/my-token');

        manager.dispose();
    });

    test('dispose cleans up everything', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        mockProc.kill = sinon.stub();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };

        const manager = new SecretlessBrokerManager(
            output as unknown as vscode.OutputChannel,
            spawner
        );
        const events: SecretInjectionEvent[] = [];
        manager.onSecretInjection(e => events.push(e));
        await manager.start({ configFilePath: '/tmp/secretless.yml', secretsDir: '/tmp/s' });

        manager.dispose();

        assert.strictEqual(manager.getState(), 'stopped');
        assert.ok(mockProc.kill.called);
    });
});

// --- Credential Provider Tests ---

suite('CredentialProvider', () => {
    function createMockSecretStorage(): SecretStorageApi & {
        store: sinon.SinonStub;
        get: sinon.SinonStub;
        delete: sinon.SinonStub;
    } {
        const storage = new Map<string, string>();
        return {
            get: sinon.stub().callsFake((key: string) => Promise.resolve(storage.get(key))),
            store: sinon.stub().callsFake((key: string, value: string) => {
                storage.set(key, value);
                return Promise.resolve();
            }),
            delete: sinon.stub().callsFake((key: string) => {
                storage.delete(key);
                return Promise.resolve();
            }),
        };
    }

    function createMockGlobalState(): GlobalStateApi & {
        getStub: sinon.SinonStub;
        updateStub: sinon.SinonStub;
    } {
        const state: Record<string, unknown> = {};
        const getStub = sinon.stub().callsFake((key: string, defaultValue: unknown) => {
            return state[key] ?? defaultValue;
        });
        const updateStub = sinon.stub().callsFake((key: string, value: unknown) => {
            state[key] = value;
            return Promise.resolve();
        });
        return { get: getStub, update: updateStub, getStub, updateStub };
    }

    function createMockOutputChannel(): { appendLine: sinon.SinonStub } {
        return { appendLine: sinon.stub() };
    }

    test('storeSecret stores value and metadata', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.example.com',
        };

        await provider.storeSecret(decl, { value: 'secret-123' });

        assert.ok(storage.store.calledOnce);
        const storedValue = JSON.parse(storage.store.firstCall.args[1]);
        assert.strictEqual(storedValue.value, 'secret-123');

        const metadata = provider.listSecrets();
        assert.strictEqual(metadata.length, 1);
        assert.strictEqual(metadata[0].name, 'my-token');
        assert.strictEqual(metadata[0].type, 'bearer_token');
    });

    test('storeSecret updates existing metadata', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.example.com',
        };

        await provider.storeSecret(decl, { value: 'v1' });
        await provider.storeSecret(decl, { value: 'v2' });

        const metadata = provider.listSecrets();
        assert.strictEqual(metadata.length, 1);
    });

    test('getSecret retrieves stored value', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-creds',
            type: 'basic_auth',
            target: 'api.internal.com',
        };

        await provider.storeSecret(decl, { username: 'admin', password: 'pass123' });

        const fields = await provider.getSecret('my-creds');
        assert.ok(fields);
        assert.strictEqual(fields!.username, 'admin');
        assert.strictEqual(fields!.password, 'pass123');
    });

    test('getSecret returns undefined for unknown secret', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const fields = await provider.getSecret('nonexistent');
        assert.strictEqual(fields, undefined);
    });

    test('deleteSecret removes value and metadata', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.example.com',
        };

        await provider.storeSecret(decl, { value: 'secret' });
        assert.strictEqual(provider.listSecrets().length, 1);

        await provider.deleteSecret('my-token');

        assert.ok(storage.delete.calledOnce);
        assert.strictEqual(provider.listSecrets().length, 0);
    });

    test('findMissingSecrets returns declarations without stored values', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decls: SecretDeclaration[] = [
            { name: 'stored-token', type: 'bearer_token', target: 'a.com' },
            { name: 'missing-token', type: 'bearer_token', target: 'b.com' },
            { name: 'missing-db', type: 'postgresql', target: 'db.com' },
        ];

        await provider.storeSecret(decls[0], { value: 'exists' });

        const missing = await provider.findMissingSecrets(decls);
        assert.strictEqual(missing.length, 2);
        assert.strictEqual(missing[0].name, 'missing-token');
        assert.strictEqual(missing[1].name, 'missing-db');
    });

    test('generateSecretFiles maps bearer_token correctly', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.example.com',
        };

        await provider.storeSecret(decl, { value: 'Bearer abc123' });

        const files = await provider.generateSecretFiles([decl]);
        assert.strictEqual(files['my-token'], 'Bearer abc123');
    });

    test('generateSecretFiles maps basic_auth correctly', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-creds',
            type: 'basic_auth',
            target: 'api.internal.com',
        };

        await provider.storeSecret(decl, { username: 'admin', password: 'pass' });

        const files = await provider.generateSecretFiles([decl]);
        assert.strictEqual(files['my-creds_username'], 'admin');
        assert.strictEqual(files['my-creds_password'], 'pass');
    });

    test('generateSecretFiles maps database secrets correctly', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-db',
            type: 'postgresql',
            target: 'db.example.com:5432',
        };

        await provider.storeSecret(decl, {
            host: 'db.example.com',
            port: '5432',
            username: 'dbuser',
            password: 'dbpass',
        });

        const files = await provider.generateSecretFiles([decl]);
        assert.strictEqual(files['my-db_host'], 'db.example.com');
        assert.strictEqual(files['my-db_port'], '5432');
        assert.strictEqual(files['my-db_username'], 'dbuser');
        assert.strictEqual(files['my-db_password'], 'dbpass');
    });

    test('generateSecretFiles skips missing secrets', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'missing-token',
            type: 'bearer_token',
            target: 'api.com',
        };

        const files = await provider.generateSecretFiles([decl]);
        assert.strictEqual(Object.keys(files).length, 0);
    });

    test('generateSecretFiles skips ssh secrets', async () => {
        const storage = createMockSecretStorage();
        const globalState = createMockGlobalState();
        const output = createMockOutputChannel();

        const provider = new CredentialProvider(
            storage,
            globalState,
            output as unknown as vscode.OutputChannel
        );

        const decl: SecretDeclaration = {
            name: 'my-ssh',
            type: 'ssh',
            target: 'server.com',
        };

        await provider.storeSecret(decl, { value: 'ssh-key-data' });

        const files = await provider.generateSecretFiles([decl]);
        assert.strictEqual(Object.keys(files).length, 0);
    });
});

// --- Prompt Tests ---

suite('Secret Prompting', () => {
    function createMockWindowApi(): WindowApi & {
        showInputBoxStub: sinon.SinonStub;
        showInfoStub: sinon.SinonStub;
        showWarnStub: sinon.SinonStub;
    } {
        const showInputBoxStub = sinon.stub().resolves('test-value');
        const showInfoStub = sinon.stub().resolves(undefined);
        const showWarnStub = sinon.stub().resolves('Yes');
        return {
            showInputBox: showInputBoxStub,
            showInformationMessage: showInfoStub,
            showWarningMessage: showWarnStub,
            showInputBoxStub,
            showInfoStub,
            showWarnStub,
        };
    }

    function createMockCredentialProvider(): CredentialProvider & {
        storeSecretStub: sinon.SinonStub;
        findMissingSecretsStub: sinon.SinonStub;
    } {
        const storeSecretStub = sinon.stub().resolves();
        const findMissingSecretsStub = sinon.stub().resolves([]);
        return {
            storeSecret: storeSecretStub,
            getSecret: sinon.stub().resolves(undefined),
            deleteSecret: sinon.stub().resolves(),
            listSecrets: sinon.stub().returns([]),
            findMissingSecrets: findMissingSecretsStub,
            generateSecretFiles: sinon.stub().resolves({}),
            dispose: sinon.stub(),
            storeSecretStub,
            findMissingSecretsStub,
        } as unknown as CredentialProvider & {
            storeSecretStub: sinon.SinonStub;
            findMissingSecretsStub: sinon.SinonStub;
        };
    }

    test('promptForSecret collects bearer_token', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub.resolves('my-secret-token');

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.com',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.ok(fields);
        assert.strictEqual(fields!.value, 'my-secret-token');
        assert.ok(windowApi.showInputBoxStub.calledOnce);

        const opts = windowApi.showInputBoxStub.firstCall.args[0];
        assert.strictEqual(opts.password, true);
    });

    test('promptForSecret collects header secret', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub.resolves('header-value');

        const decl: SecretDeclaration = {
            name: 'my-header',
            type: 'header',
            target: 'api.com',
            headerName: 'X-API-Key',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.ok(fields);
        assert.strictEqual(fields!.value, 'header-value');

        const promptText = windowApi.showInputBoxStub.firstCall.args[0].prompt;
        assert.ok(promptText.includes('X-API-Key'));
    });

    test('promptForSecret collects basic_auth credentials', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub
            .onFirstCall().resolves('admin')
            .onSecondCall().resolves('password123');

        const decl: SecretDeclaration = {
            name: 'my-creds',
            type: 'basic_auth',
            target: 'api.internal.com',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.ok(fields);
        assert.strictEqual(fields!.username, 'admin');
        assert.strictEqual(fields!.password, 'password123');
        assert.ok(windowApi.showInputBoxStub.calledTwice);
    });

    test('promptForSecret collects database credentials', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub
            .onCall(0).resolves('db.example.com')
            .onCall(1).resolves('5432')
            .onCall(2).resolves('dbuser')
            .onCall(3).resolves('dbpass');

        const decl: SecretDeclaration = {
            name: 'my-db',
            type: 'postgresql',
            target: 'db.example.com:5432',
            listenPort: 5432,
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.ok(fields);
        assert.strictEqual(fields!.host, 'db.example.com');
        assert.strictEqual(fields!.port, '5432');
        assert.strictEqual(fields!.username, 'dbuser');
        assert.strictEqual(fields!.password, 'dbpass');
        assert.strictEqual(windowApi.showInputBoxStub.callCount, 4);
    });

    test('promptForSecret returns undefined when user cancels', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub.resolves(undefined);

        const decl: SecretDeclaration = {
            name: 'my-token',
            type: 'bearer_token',
            target: 'api.com',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.strictEqual(fields, undefined);
    });

    test('promptForSecret returns undefined when user cancels password in basic_auth', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub
            .onFirstCall().resolves('admin')
            .onSecondCall().resolves(undefined);

        const decl: SecretDeclaration = {
            name: 'my-creds',
            type: 'basic_auth',
            target: 'api.com',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.strictEqual(fields, undefined);
    });

    test('promptForSecret returns empty fields for ssh', async () => {
        const windowApi = createMockWindowApi();

        const decl: SecretDeclaration = {
            name: 'my-ssh',
            type: 'ssh',
            target: 'server.com',
        };

        const fields = await promptForSecret(decl, windowApi);
        assert.ok(fields);
        assert.strictEqual(fields!.value, '');
    });

    test('promptForMissingSecrets prompts when secrets are missing', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub.resolves('token-value');

        const credProvider = createMockCredentialProvider();
        const missingDecl: SecretDeclaration = {
            name: 'missing-token',
            type: 'bearer_token',
            target: 'api.com',
        };
        credProvider.findMissingSecretsStub.resolves([missingDecl]);

        const count = await promptForMissingSecrets([missingDecl], credProvider, windowApi);

        assert.strictEqual(count, 1);
        assert.ok(windowApi.showWarnStub.calledOnce);
        assert.ok(credProvider.storeSecretStub.calledOnce);
    });

    test('promptForMissingSecrets returns 0 when no secrets missing', async () => {
        const windowApi = createMockWindowApi();
        const credProvider = createMockCredentialProvider();
        credProvider.findMissingSecretsStub.resolves([]);

        const count = await promptForMissingSecrets([], credProvider, windowApi);
        assert.strictEqual(count, 0);
    });

    test('promptForMissingSecrets returns 0 when user skips', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showWarnStub.resolves('Skip');

        const credProvider = createMockCredentialProvider();
        const missingDecl: SecretDeclaration = {
            name: 'missing-token',
            type: 'bearer_token',
            target: 'api.com',
        };
        credProvider.findMissingSecretsStub.resolves([missingDecl]);

        const count = await promptForMissingSecrets([missingDecl], credProvider, windowApi);
        assert.strictEqual(count, 0);
        assert.ok(credProvider.storeSecretStub.notCalled);
    });

    test('promptForMissingSecrets shows success message after collecting', async () => {
        const windowApi = createMockWindowApi();
        windowApi.showInputBoxStub.resolves('value');

        const credProvider = createMockCredentialProvider();
        const missingDecl: SecretDeclaration = {
            name: 'token',
            type: 'bearer_token',
            target: 'api.com',
        };
        credProvider.findMissingSecretsStub.resolves([missingDecl]);

        await promptForMissingSecrets([missingDecl], credProvider, windowApi);

        assert.ok(windowApi.showInfoStub.calledOnce);
        assert.ok(windowApi.showInfoStub.firstCall.args[0].includes('1 secret(s)'));
    });
});
