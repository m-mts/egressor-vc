import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { parseLogLine, parseOutput, createStreamParser } from '../../jail/events';
import { detectHttpjail, getDownloadUrl, SystemOperations } from '../../jail/installer';
import { HttpjailManager, ProcessSpawner } from '../../jail/manager';
import { TrafficEvent } from '../../jail/types';

// --- Event Parsing Tests ---

suite('httpjail Event Parsing', () => {
    test('parses HTTP allowed request', () => {
        const event = parseLogLine('ALLOW GET registry.npmjs.org:443 /package/foo 12ms');
        assert.ok(event);
        assert.strictEqual(event!.method, 'GET');
        assert.strictEqual(event!.host, 'registry.npmjs.org');
        assert.strictEqual(event!.port, 443);
        assert.strictEqual(event!.path, '/package/foo');
        assert.strictEqual(event!.status, 'allowed');
        assert.strictEqual(event!.category, 'http');
        assert.strictEqual(event!.durationMs, 12);
    });

    test('parses HTTP allowed request without port', () => {
        const event = parseLogLine('ALLOW GET registry.npmjs.org /package/foo 5ms');
        assert.ok(event);
        assert.strictEqual(event!.host, 'registry.npmjs.org');
        assert.strictEqual(event!.port, undefined);
    });

    test('parses HTTP allowed request without duration', () => {
        const event = parseLogLine('ALLOW GET registry.npmjs.org:443 /package/foo');
        assert.ok(event);
        assert.strictEqual(event!.durationMs, undefined);
    });

    test('parses HTTP blocked request', () => {
        const event = parseLogLine('BLOCK POST api.evil.com:443 /exfiltrate');
        assert.ok(event);
        assert.strictEqual(event!.method, 'POST');
        assert.strictEqual(event!.host, 'api.evil.com');
        assert.strictEqual(event!.port, 443);
        assert.strictEqual(event!.path, '/exfiltrate');
        assert.strictEqual(event!.status, 'blocked');
        assert.strictEqual(event!.category, 'http');
    });

    test('parses HTTP blocked request without path', () => {
        const event = parseLogLine('BLOCK GET api.evil.com:443');
        assert.ok(event);
        assert.strictEqual(event!.status, 'blocked');
        assert.strictEqual(event!.path, '/');
    });

    test('parses CONNECT allowed', () => {
        const event = parseLogLine('ALLOW CONNECT registry.npmjs.org:443');
        assert.ok(event);
        assert.strictEqual(event!.method, 'CONNECT');
        assert.strictEqual(event!.host, 'registry.npmjs.org');
        assert.strictEqual(event!.port, 443);
        assert.strictEqual(event!.status, 'allowed');
        assert.strictEqual(event!.category, 'http');
    });

    test('parses CONNECT blocked', () => {
        const event = parseLogLine('BLOCK CONNECT evil.com:443');
        assert.ok(event);
        assert.strictEqual(event!.method, 'CONNECT');
        assert.strictEqual(event!.host, 'evil.com');
        assert.strictEqual(event!.status, 'blocked');
    });

    test('parses non-HTTP blocked traffic', () => {
        const event = parseLogLine('BLOCK-TCP 10.0.0.5:3306 (non-HTTP)');
        assert.ok(event);
        assert.strictEqual(event!.host, '10.0.0.5');
        assert.strictEqual(event!.port, 3306);
        assert.strictEqual(event!.status, 'blocked');
        assert.strictEqual(event!.category, 'non-http');
        assert.strictEqual(event!.protocol, 'tcp');
    });

    test('parses DNS resolution', () => {
        const event = parseLogLine('DNS registry.npmjs.org -> 104.16.0.35');
        assert.ok(event);
        assert.strictEqual(event!.host, 'registry.npmjs.org');
        assert.strictEqual(event!.status, 'allowed');
        assert.strictEqual(event!.category, 'dns');
        assert.strictEqual(event!.protocol, 'udp');
    });

    test('returns undefined for empty line', () => {
        assert.strictEqual(parseLogLine(''), undefined);
        assert.strictEqual(parseLogLine('   '), undefined);
    });

    test('returns undefined for unrecognized line', () => {
        assert.strictEqual(parseLogLine('httpjail starting on port 8080'), undefined);
        assert.strictEqual(parseLogLine('some random log output'), undefined);
    });

    test('parses multiple lines with parseOutput', () => {
        const output = [
            'ALLOW GET registry.npmjs.org:443 /package 5ms',
            'BLOCK POST evil.com:443 /data',
            'some noise',
            'DNS example.com -> 1.2.3.4',
        ].join('\n');

        const events = parseOutput(output);
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].status, 'allowed');
        assert.strictEqual(events[1].status, 'blocked');
        assert.strictEqual(events[2].category, 'dns');
    });

    test('parseOutput handles empty string', () => {
        const events = parseOutput('');
        assert.strictEqual(events.length, 0);
    });
});

suite('httpjail Stream Parser', () => {
    test('emits events for complete lines', () => {
        const events: TrafficEvent[] = [];
        const parser = createStreamParser(e => events.push(e));

        parser.push('ALLOW GET example.com:443 /path 10ms\n');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].host, 'example.com');
    });

    test('buffers partial lines', () => {
        const events: TrafficEvent[] = [];
        const parser = createStreamParser(e => events.push(e));

        parser.push('ALLOW GET example');
        assert.strictEqual(events.length, 0);

        parser.push('.com:443 /path 10ms\n');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].host, 'example.com');
    });

    test('handles multiple lines in one chunk', () => {
        const events: TrafficEvent[] = [];
        const parser = createStreamParser(e => events.push(e));

        parser.push('ALLOW GET a.com:443 /x\nBLOCK POST b.com:443 /y\n');
        assert.strictEqual(events.length, 2);
    });

    test('flush processes remaining buffer', () => {
        const events: TrafficEvent[] = [];
        const parser = createStreamParser(e => events.push(e));

        parser.push('DNS example.com -> 1.2.3.4');
        assert.strictEqual(events.length, 0);

        parser.flush();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].category, 'dns');
    });

    test('flush with empty buffer does nothing', () => {
        const events: TrafficEvent[] = [];
        const parser = createStreamParser(e => events.push(e));
        parser.flush();
        assert.strictEqual(events.length, 0);
    });
});

// --- Installer Tests ---

suite('httpjail Installer', () => {
    test('detects httpjail on PATH', () => {
        const sysOps: SystemOperations = {
            execSync: sinon.stub()
                .onFirstCall().returns('/usr/local/bin/httpjail')
                .onSecondCall().returns('httpjail v0.3.0'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const result = detectHttpjail(sysOps);
        assert.ok(result.found);
        assert.strictEqual(result.path, '/usr/local/bin/httpjail');
        assert.strictEqual(result.version, '0.3.0');
    });

    test('detects httpjail at known path when not on PATH', () => {
        const sysOps: SystemOperations = {
            execSync: sinon.stub()
                .onFirstCall().throws(new Error('not found'))
                .onSecondCall().returns('0.2.0'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: (p: string) => p === '/usr/local/bin/httpjail',
        };

        const result = detectHttpjail(sysOps);
        assert.ok(result.found);
        assert.strictEqual(result.path, '/usr/local/bin/httpjail');
    });

    test('returns not found when binary is absent', () => {
        const sysOps: SystemOperations = {
            execSync: sinon.stub().throws(new Error('not found')),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const result = detectHttpjail(sysOps);
        assert.ok(!result.found);
        assert.strictEqual(result.path, undefined);
    });

    test('getDownloadUrl returns linux/amd64 URL', () => {
        const url = getDownloadUrl('linux', 'x64');
        assert.ok(url);
        assert.ok(url!.includes('linux_amd64'));
    });

    test('getDownloadUrl returns darwin/arm64 URL', () => {
        const url = getDownloadUrl('darwin', 'arm64');
        assert.ok(url);
        assert.ok(url!.includes('darwin_arm64'));
    });

    test('getDownloadUrl returns undefined for windows', () => {
        const url = getDownloadUrl('win32', 'x64');
        assert.strictEqual(url, undefined);
    });

    test('getDownloadUrl returns undefined for unsupported arch', () => {
        const url = getDownloadUrl('linux', 'ia32');
        assert.strictEqual(url, undefined);
    });
});

// --- Manager Tests ---

suite('httpjail Manager', () => {
    let sandbox: sinon.SinonSandbox;

    function createMockOutputChannel(): { appendLine: sinon.SinonStub } {
        return {
            appendLine: sinon.stub(),
        };
    }

    function createMockProcess(): EventEmitter & { pid: number; killed: boolean; kill: sinon.SinonStub; stdout: EventEmitter; stderr: EventEmitter } {
        const proc = new EventEmitter() as EventEmitter & {
            pid: number;
            killed: boolean;
            kill: sinon.SinonStub;
            stdout: EventEmitter;
            stderr: EventEmitter;
        };
        proc.pid = 12345;
        proc.killed = false;
        proc.kill = sinon.stub().callsFake((signal?: string) => {
            proc.killed = true;
            // Simulate async exit
            setTimeout(() => proc.emit('exit', 0, signal || null), 10);
        });
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        return proc;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('initial state is stopped', () => {
        const output = createMockOutputChannel();
        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel);
        assert.strictEqual(manager.getState(), 'stopped');
        manager.dispose();
    });

    test('healthCheck returns correct status when stopped', () => {
        const output = createMockOutputChannel();
        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel);
        const health = manager.healthCheck();
        assert.strictEqual(health.alive, false);
        assert.strictEqual(health.state, 'stopped');
        assert.strictEqual(health.pid, undefined);
        manager.dispose();
    });

    test('start succeeds with detected binary', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = {
            spawn: sinon.stub().returns(mockProc),
        };
        const sysOps: SystemOperations = {
            execSync: sinon.stub()
                .onFirstCall().returns('/usr/local/bin/httpjail')
                .onSecondCall().returns('v0.3.0'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        const result = await manager.start({ rulesFilePath: '/tmp/rules.js' });

        assert.ok(result);
        assert.strictEqual(manager.getState(), 'running');

        const health = manager.healthCheck();
        assert.ok(health.alive);
        assert.strictEqual(health.pid, 12345);
        assert.ok(health.uptimeMs !== undefined && health.uptimeMs >= 0);

        manager.dispose();
    });

    test('start builds correct args with all options', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawnStub = sinon.stub().returns(mockProc);
        const spawner: ProcessSpawner = { spawn: spawnStub };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({
            rulesFilePath: '/tmp/rules.js',
            containerId: 'my-container',
            strongMode: true,
            proxyPort: 8080,
        });

        const args = spawnStub.firstCall.args[1];
        assert.ok(args.includes('--rules'));
        assert.ok(args.includes('/tmp/rules.js'));
        assert.ok(args.includes('--docker-run'));
        assert.ok(args.includes('my-container'));
        assert.ok(args.includes('--strong'));
        assert.ok(args.includes('--port'));
        assert.ok(args.includes('8080'));

        manager.dispose();
    });

    test('start fails when binary not found', async () => {
        const output = createMockOutputChannel();
        const sysOps: SystemOperations = {
            execSync: sinon.stub().throws(new Error('not found')),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        // Mock vscode.window.showWarningMessage to decline install
        (vscode.window.showWarningMessage as sinon.SinonStub).resolves('Cancel');

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, undefined, sysOps);
        const result = await manager.start({ rulesFilePath: '/tmp/rules.js' });

        assert.ok(!result);
        assert.strictEqual(manager.getState(), 'error');

        manager.dispose();
    });

    test('start returns true if already running', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js' });
        const result = await manager.start({ rulesFilePath: '/tmp/rules.js' });
        assert.ok(result);

        manager.dispose();
    });

    test('stop transitions to stopped state', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js' });
        assert.strictEqual(manager.getState(), 'running');

        await manager.stop();
        assert.strictEqual(manager.getState(), 'stopped');

        const health = manager.healthCheck();
        assert.ok(!health.alive);

        manager.dispose();
    });

    test('stop is safe when already stopped', async () => {
        const output = createMockOutputChannel();
        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel);
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
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js' });
        const result = await manager.restart();

        assert.ok(result);
        assert.strictEqual(manager.getState(), 'running');
        assert.ok(spawnStub.calledTwice);

        manager.dispose();
    });

    test('restart fails when no previous options', async () => {
        const output = createMockOutputChannel();
        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel);
        const result = await manager.restart();

        assert.ok(!result);
        assert.strictEqual(manager.getState(), 'error');

        manager.dispose();
    });

    test('restart accepts new options', async () => {
        const output = createMockOutputChannel();
        const mockProc1 = createMockProcess();
        const mockProc2 = createMockProcess();
        const spawnStub = sinon.stub()
            .onFirstCall().returns(mockProc1)
            .onSecondCall().returns(mockProc2);
        const spawner: ProcessSpawner = { spawn: spawnStub };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules1.js' });
        await manager.restart({ rulesFilePath: '/tmp/rules2.js' });

        const args = spawnStub.secondCall.args[1];
        assert.ok(args.includes('/tmp/rules2.js'));

        manager.dispose();
    });

    test('reloadRules restarts with new rules file', async () => {
        const output = createMockOutputChannel();
        const mockProc1 = createMockProcess();
        const mockProc2 = createMockProcess();
        const spawnStub = sinon.stub()
            .onFirstCall().returns(mockProc1)
            .onSecondCall().returns(mockProc2);
        const spawner: ProcessSpawner = { spawn: spawnStub };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js', containerId: 'ctr' });

        const result = await manager.reloadRules('/tmp/new-rules.js');
        assert.ok(result);

        const args = spawnStub.secondCall.args[1];
        assert.ok(args.includes('/tmp/new-rules.js'));
        assert.ok(args.includes('ctr'), 'Should preserve containerId');

        manager.dispose();
    });

    test('reloadRules fails when not running', async () => {
        const output = createMockOutputChannel();
        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel);
        const result = await manager.reloadRules('/tmp/rules.js');
        assert.ok(!result);
        manager.dispose();
    });

    test('emits traffic events from stdout', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        const events: TrafficEvent[] = [];
        manager.onTrafficEvent(e => events.push(e));

        await manager.start({ rulesFilePath: '/tmp/rules.js' });

        // Simulate stdout data
        mockProc.stdout.emit('data', Buffer.from('ALLOW GET example.com:443 /path 5ms\n'));
        mockProc.stdout.emit('data', Buffer.from('BLOCK POST evil.com:443 /data\n'));

        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].status, 'allowed');
        assert.strictEqual(events[0].host, 'example.com');
        assert.strictEqual(events[1].status, 'blocked');
        assert.strictEqual(events[1].host, 'evil.com');

        manager.dispose();
    });

    test('emits traffic events from stderr', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        const events: TrafficEvent[] = [];
        manager.onTrafficEvent(e => events.push(e));

        await manager.start({ rulesFilePath: '/tmp/rules.js' });

        mockProc.stderr.emit('data', Buffer.from('BLOCK-TCP 10.0.0.5:3306 (non-HTTP)\n'));

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].category, 'non-http');

        manager.dispose();
    });

    test('listener disposal works', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        const events: TrafficEvent[] = [];
        const disposable = manager.onTrafficEvent(e => events.push(e));

        await manager.start({ rulesFilePath: '/tmp/rules.js' });

        mockProc.stdout.emit('data', Buffer.from('ALLOW GET a.com:443 /x\n'));
        assert.strictEqual(events.length, 1);

        disposable.dispose();

        mockProc.stdout.emit('data', Buffer.from('ALLOW GET b.com:443 /y\n'));
        assert.strictEqual(events.length, 1, 'Should not receive events after disposal');

        manager.dispose();
    });

    test('handles unexpected process exit', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        // Override kill to not emit exit (we'll emit it manually)
        mockProc.kill = sinon.stub();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js' });
        assert.strictEqual(manager.getState(), 'running');

        // Simulate unexpected exit
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
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        await manager.start({ rulesFilePath: '/tmp/rules.js' });

        mockProc.emit('error', new Error('spawn ENOENT'));
        assert.strictEqual(manager.getState(), 'error');

        const health = manager.healthCheck();
        assert.strictEqual(health.error, 'spawn ENOENT');

        manager.dispose();
    });

    test('dispose cleans up everything', async () => {
        const output = createMockOutputChannel();
        const mockProc = createMockProcess();
        mockProc.kill = sinon.stub();
        const spawner: ProcessSpawner = { spawn: sinon.stub().returns(mockProc) };
        const sysOps: SystemOperations = {
            execSync: sinon.stub().returns('/usr/local/bin/httpjail'),
            platform: () => 'linux',
            arch: () => 'x64',
            existsSync: () => false,
        };

        const manager = new HttpjailManager(output as unknown as vscode.OutputChannel, spawner, sysOps);
        const events: TrafficEvent[] = [];
        manager.onTrafficEvent(e => events.push(e));
        await manager.start({ rulesFilePath: '/tmp/rules.js' });

        manager.dispose();

        assert.strictEqual(manager.getState(), 'stopped');
        assert.ok(mockProc.kill.called);
    });
});
