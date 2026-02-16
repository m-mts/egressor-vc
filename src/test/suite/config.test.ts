import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { parseConfig, resolveConfig, getPresetRules } from '../../config/parser';
import { generateSecretlessConfig, generateSecretlessYaml } from '../../config/secretless-generator';
import { generateHttpjailRules, generateHttpjailRuleExpression } from '../../config/httpjail-rules-generator';
import { ConfigWatcher, FileSystem } from '../../config/watcher';
import { EgressorConfig, ResolvedConfig } from '../../config/types';

suite('Config Parser', () => {
    test('parses valid minimal config', () => {
        const yaml = `
version: "1"
rules:
  - host: registry.npmjs.org
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok, 'Should parse successfully');
        if (result.ok) {
            assert.strictEqual(result.config.version, '1');
            assert.strictEqual(result.config.rules.length, 1);
            assert.strictEqual(result.config.rules[0].host, 'registry.npmjs.org');
        }
    });

    test('parses config with methods and paths', () => {
        const yaml = `
version: "1"
rules:
  - host: api.example.com
    methods: [GET, POST]
    paths: ["/api/v1", "/api/v2"]
    description: Example API
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            const rule = result.config.rules[0];
            assert.deepStrictEqual(rule.methods, ['GET', 'POST']);
            assert.deepStrictEqual(rule.paths, ['/api/v1', '/api/v2']);
            assert.strictEqual(rule.description, 'Example API');
        }
    });

    test('parses config with secrets', () => {
        const yaml = `
version: "1"
rules:
  - host: api.example.com
secrets:
  - name: my-api-key
    type: bearer_token
    target: api.example.com
  - name: my-db
    type: postgresql
    target: db.example.com:5432
    listenPort: 5432
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            assert.strictEqual(result.config.secrets!.length, 2);
            assert.strictEqual(result.config.secrets![0].type, 'bearer_token');
            assert.strictEqual(result.config.secrets![1].type, 'postgresql');
            assert.strictEqual(result.config.secrets![1].listenPort, 5432);
        }
    });

    test('parses config with presets', () => {
        const yaml = `
version: "1"
presets:
  - node-fullstack
rules:
  - host: my-api.example.com
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            assert.deepStrictEqual(result.config.presets, ['node-fullstack']);
        }
    });

    test('rejects invalid YAML', () => {
        const result = parseConfig('{{invalid yaml');
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors[0].message.includes('Invalid YAML'));
        }
    });

    test('rejects missing version', () => {
        const yaml = `
rules:
  - host: example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'version'));
        }
    });

    test('rejects missing rules', () => {
        const yaml = `
version: "1"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'rules'));
        }
    });

    test('rejects rule without host', () => {
        const yaml = `
version: "1"
rules:
  - methods: [GET]
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'rules[0].host'));
        }
    });

    test('rejects invalid HTTP method', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
    methods: [GET, INVALID]
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.message.includes('INVALID')));
        }
    });

    test('rejects invalid preset', () => {
        const yaml = `
version: "1"
presets:
  - not-a-real-preset
rules:
  - host: example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.message.includes('not-a-real-preset')));
        }
    });

    test('rejects secret missing name', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
secrets:
  - type: bearer_token
    target: api.example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'secrets[0].name'));
        }
    });

    test('rejects header secret missing headerName', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
secrets:
  - name: my-header
    type: header
    target: api.example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'secrets[0].headerName'));
        }
    });

    test('rejects database secret missing listenPort', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
secrets:
  - name: my-db
    type: postgresql
    target: db.example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'secrets[0].listenPort'));
        }
    });

    test('rejects non-object config', () => {
        const result = parseConfig('just a string');
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'root'));
        }
    });

    test('rejects non-array rules', () => {
        const yaml = `
version: "1"
rules: "not an array"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-array secrets', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
secrets: "not an array"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-object rule', () => {
        const yaml = `
version: "1"
rules:
  - "just a string"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-object secret', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
secrets:
  - "just a string"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-string path in rule', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
    paths:
      - 123
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-array methods', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
    methods: "GET"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });

    test('rejects non-array presets', () => {
        const yaml = `
version: "1"
presets: "node-fullstack"
rules:
  - host: example.com
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
    });
});

suite('Preset Resolution', () => {
    test('resolves config without presets', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
        };
        const resolved = resolveConfig(config);
        assert.strictEqual(resolved.rules.length, 1);
        assert.strictEqual(resolved.rules[0].host, 'example.com');
        assert.deepStrictEqual(resolved.secrets, []);
    });

    test('resolves node-fullstack preset', () => {
        const config: EgressorConfig = {
            version: '1',
            presets: ['node-fullstack'],
            rules: [{ host: 'my-api.example.com' }],
        };
        const resolved = resolveConfig(config);
        // Should have explicit rule + preset rules
        assert.ok(resolved.rules.length > 1);
        assert.ok(resolved.rules.some(r => r.host === 'my-api.example.com'));
        assert.ok(resolved.rules.some(r => r.host === 'registry.npmjs.org'));
    });

    test('deduplicates rules when preset overlaps with explicit', () => {
        const config: EgressorConfig = {
            version: '1',
            presets: ['node-fullstack'],
            rules: [{ host: 'registry.npmjs.org', methods: ['GET'], description: 'explicit' }],
        };
        const resolved = resolveConfig(config);
        // Explicit rule should take priority
        const npmRule = resolved.rules.find(r => r.host === 'registry.npmjs.org');
        assert.ok(npmRule);
        assert.deepStrictEqual(npmRule!.methods, ['GET']);
        assert.strictEqual(npmRule!.description, 'explicit');
        // Should not have duplicate
        const npmRules = resolved.rules.filter(r => r.host === 'registry.npmjs.org');
        assert.strictEqual(npmRules.length, 1);
    });

    test('resolves multiple presets', () => {
        const config: EgressorConfig = {
            version: '1',
            presets: ['node-fullstack', 'python-data-science'],
            rules: [],
        };
        const resolved = resolveConfig(config);
        assert.ok(resolved.rules.some(r => r.host === 'registry.npmjs.org'));
        assert.ok(resolved.rules.some(r => r.host === 'pypi.org'));
    });

    test('getPresetRules returns rules for valid preset', () => {
        const rules = getPresetRules('go-standard');
        assert.ok(rules.length > 0);
        assert.ok(rules.some(r => r.host === 'proxy.golang.org'));
    });

    test('preserves secrets during resolution', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            secrets: [{ name: 'my-token', type: 'bearer_token', target: 'api.example.com' }],
        };
        const resolved = resolveConfig(config);
        assert.strictEqual(resolved.secrets.length, 1);
        assert.strictEqual(resolved.secrets[0].name, 'my-token');
    });
});

suite('Secretless Config Generator', () => {
    test('generates config for bearer_token secret', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{ name: 'github-token', type: 'bearer_token', target: 'api.github.com' }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        assert.strictEqual(result.version, '2');
        assert.ok(result.services['github-token']);
        assert.strictEqual(result.services['github-token'].protocol, 'http');
        assert.ok(result.services['github-token'].credentials['accessToken']);
    });

    test('generates config for header secret', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{
                name: 'api-key',
                type: 'header',
                target: 'api.example.com',
                headerName: 'X-API-Key',
            }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        assert.ok(result.services['api-key']);
        assert.ok(result.services['api-key'].credentials['X-API-Key']);
    });

    test('generates config for basic_auth secret', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{ name: 'basic-creds', type: 'basic_auth', target: 'secure.example.com' }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        const svc = result.services['basic-creds'];
        assert.ok(svc);
        assert.ok(svc.credentials['username']);
        assert.ok(svc.credentials['password']);
    });

    test('generates config for postgresql secret', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{
                name: 'my-pg',
                type: 'postgresql',
                target: 'db.example.com:5432',
                listenPort: 5432,
            }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        const svc = result.services['my-pg'];
        assert.ok(svc);
        assert.strictEqual(svc.protocol, 'pg');
        assert.strictEqual(svc.listenOn, 'tcp://0.0.0.0:5432');
        assert.ok(svc.credentials['host']);
        assert.ok(svc.credentials['username']);
        assert.ok(svc.credentials['password']);
    });

    test('generates config for mysql secret', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{
                name: 'my-mysql',
                type: 'mysql',
                target: 'db.example.com:3306',
                listenPort: 3306,
            }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        const svc = result.services['my-mysql'];
        assert.ok(svc);
        assert.strictEqual(svc.protocol, 'mysql');
    });

    test('skips ssh secrets', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{ name: 'my-ssh', type: 'ssh', target: 'server.example.com' }],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        assert.strictEqual(Object.keys(result.services).length, 0);
    });

    test('generates valid YAML output', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{ name: 'token', type: 'bearer_token', target: 'api.example.com' }],
        };
        const yamlOutput = generateSecretlessYaml(config, '/test/secrets');
        assert.ok(yamlOutput.includes('version:'));
        assert.ok(yamlOutput.includes('services:'));
        assert.ok(yamlOutput.includes('token:'));
    });

    test('generates empty services for no secrets', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            secrets: [],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        assert.strictEqual(Object.keys(result.services).length, 0);
    });
});

suite('Httpjail Rules Generator', () => {
    test('generates rule for simple host', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('host === "registry.npmjs.org"'));
    });

    test('generates rule for wildcard host', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: '*.github.com' }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('host === "github.com"'));
        assert.ok(rules.includes('host.endsWith(".github.com")'));
    });

    test('generates rule with method filter', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'api.example.com', methods: ['GET', 'POST'] }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('["GET", "POST"].includes(method)'));
    });

    test('generates rule with path filter', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'api.example.com', paths: ['/api/v1', '/api/v2'] }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('path.startsWith("/api/v1")'));
        assert.ok(rules.includes('path.startsWith("/api/v2")'));
    });

    test('generates combined rule with host, method, and path', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{
                host: 'api.example.com',
                methods: ['GET'],
                paths: ['/api'],
                description: 'Example',
            }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('host === "api.example.com"'));
        assert.ok(rules.includes('["GET"].includes(method)'));
        assert.ok(rules.includes('path.startsWith("/api")'));
    });

    test('generates false for no rules', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('false'));
    });

    test('generates multiple rules with OR', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [
                { host: 'a.com' },
                { host: 'b.com' },
            ],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('host === "a.com"'));
        assert.ok(rules.includes('host === "b.com"'));
        assert.ok(rules.includes('||'));
    });

    test('generates compact rule expression', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [
                { host: 'a.com' },
                { host: 'b.com' },
            ],
            secrets: [],
        };
        const expr = generateHttpjailRuleExpression(config);
        assert.ok(expr.includes('host === "a.com"'));
        assert.ok(expr.includes('host === "b.com"'));
        assert.ok(expr.includes('||'));
    });

    test('compact expression returns false for no rules', () => {
        const config: ResolvedConfig = { version: '1', rules: [], secrets: [] };
        assert.strictEqual(generateHttpjailRuleExpression(config), 'false');
    });

    test('includes description as comment', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'example.com', description: 'My service' }],
            secrets: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('// My service'));
    });
});

suite('Config Watcher', () => {
    let sandbox: sinon.SinonSandbox;

    function createMockFs(overrides: Partial<FileSystem> = {}): FileSystem {
        return {
            readFileSync: sinon.stub().returns(''),
            writeFileSync: sinon.stub(),
            existsSync: sinon.stub().returns(true),
            mkdirSync: sinon.stub(),
            ...overrides,
        };
    }

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('creates file system watcher on start', () => {
        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const mockFs = createMockFs();
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);
        watcher.start();

        const createWatcher = vscode.workspace.createFileSystemWatcher as unknown as sinon.SinonStub;
        assert.ok(createWatcher.called, 'Should create file system watcher');

        watcher.dispose();
    });

    test('reload parses config and calls onConfigChanged', () => {
        const configYaml = `
version: "1"
rules:
  - host: example.com
`;
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(result => {
            assert.ok(result);
            assert.strictEqual(result!.rules.length, 1);
            assert.ok(callbacks.onConfigChanged.calledOnce);
            watcher.dispose();
        });
    });

    test('reload calls onConfigError for invalid config', () => {
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns('invalid: yaml: content: ['),
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(result => {
            assert.strictEqual(result, undefined);
            assert.ok(callbacks.onConfigError.called);
            watcher.dispose();
        });
    });

    test('reload calls onConfigError when file cannot be read', () => {
        const mockFs = createMockFs({
            readFileSync: sinon.stub().throws(new Error('ENOENT')),
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(result => {
            assert.strictEqual(result, undefined);
            assert.ok(callbacks.onConfigError.calledWith(['Could not read .egressor.yml']));
            watcher.dispose();
        });
    });

    test('reload writes derived config files', () => {
        const configYaml = `
version: "1"
rules:
  - host: example.com
secrets:
  - name: token
    type: bearer_token
    target: api.example.com
`;
        const writeStub = sinon.stub();
        const mkdirStub = sinon.stub();
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
            existsSync: sinon.stub().returns(false),
            mkdirSync: mkdirStub,
            writeFileSync: writeStub,
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(() => {
            assert.ok(mkdirStub.called, 'Should create output directory');
            // Should write httpjail rules and secretless.yml
            assert.ok(writeStub.calledTwice, `Expected 2 writes, got ${writeStub.callCount}`);
            const writtenPaths = writeStub.getCalls().map(c => String(c.args[0]));
            assert.ok(writtenPaths.some(p => p.includes('httpjail-rules.js')));
            assert.ok(writtenPaths.some(p => p.includes('secretless.yml')));
            watcher.dispose();
        });
    });

    test('getConfig returns undefined before reload', () => {
        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const mockFs = createMockFs();
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);
        assert.strictEqual(watcher.getConfig(), undefined);
        watcher.dispose();
    });

    test('getConfig returns config after reload', () => {
        const configYaml = `
version: "1"
rules:
  - host: example.com
`;
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(() => {
            const config = watcher.getConfig();
            assert.ok(config);
            assert.strictEqual(config!.rules[0].host, 'example.com');
            watcher.dispose();
        });
    });

    test('dispose cleans up resources', () => {
        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const mockFs = createMockFs();
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);
        watcher.start();
        watcher.dispose();
        // Should not throw on double dispose
        assert.doesNotThrow(() => watcher.dispose());
    });
});
