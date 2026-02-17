import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { parseConfig, resolveConfig, getPresetRules } from '../../config/parser';
import { generateSecretlessConfig, generateSecretlessYaml, generateSecretlessYamlFromArray, generatePerContainerSecretlessYaml } from '../../config/secretless-generator';
import { generateHttpjailRules, generateHttpjailRuleExpression, generateHttpjailRulesFromArray, generatePerContainerHttpjailRules } from '../../config/httpjail-rules-generator';
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
            containers: [],
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
            containers: [],
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
            containers: [],
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
            containers: [],
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
            containers: [],
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
            containers: [],
        };
        const result = generateSecretlessConfig(config, '/test/secrets');
        assert.strictEqual(Object.keys(result.services).length, 0);
    });

    test('generates valid YAML output', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [{ name: 'token', type: 'bearer_token', target: 'api.example.com' }],
            containers: [],
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
            containers: [],
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
            containers: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('host === "registry.npmjs.org"'));
    });

    test('generates rule for wildcard host', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: '*.github.com' }],
            secrets: [],
            containers: [],
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
            containers: [],
        };
        const rules = generateHttpjailRules(config);
        assert.ok(rules.includes('["GET", "POST"].includes(method)'));
    });

    test('generates rule with path filter', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'api.example.com', paths: ['/api/v1', '/api/v2'] }],
            secrets: [],
            containers: [],
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
            containers: [],
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
            containers: [],
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
            containers: [],
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
            containers: [],
        };
        const expr = generateHttpjailRuleExpression(config);
        assert.ok(expr.includes('host === "a.com"'));
        assert.ok(expr.includes('host === "b.com"'));
        assert.ok(expr.includes('||'));
    });

    test('compact expression returns false for no rules', () => {
        const config: ResolvedConfig = { version: '1', rules: [], secrets: [], containers: [] };
        assert.strictEqual(generateHttpjailRuleExpression(config), 'false');
    });

    test('includes description as comment', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'example.com', description: 'My service' }],
            secrets: [],
            containers: [],
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

suite('Container Config Parsing', () => {
    test('parses config with containers field', () => {
        const yaml = `
version: "1"
rules:
  - host: registry.npmjs.org
containers:
  - name: backend
    match:
      image: "node:*"
    egress: true
    secrets: true
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok, 'Should parse successfully');
        if (result.ok) {
            assert.strictEqual(result.config.containers!.length, 1);
            assert.strictEqual(result.config.containers![0].name, 'backend');
            assert.strictEqual(result.config.containers![0].match.image, 'node:*');
            assert.strictEqual(result.config.containers![0].egress, true);
            assert.strictEqual(result.config.containers![0].secrets, true);
        }
    });

    test('parses config without containers field (backward compatible)', () => {
        const yaml = `
version: "1"
rules:
  - host: registry.npmjs.org
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            assert.strictEqual(result.config.containers, undefined);
        }
    });

    test('parses container with match by name', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: web
    match:
      name: "my-web-*"
    egress: true
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            assert.strictEqual(result.config.containers![0].match.name, 'my-web-*');
        }
    });

    test('parses container with match by label', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: worker
    match:
      label:
        role: worker
        env: production
    egress: true
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            assert.deepStrictEqual(result.config.containers![0].match.label, { role: 'worker', env: 'production' });
        }
    });

    test('parses container with custom egress rules array', () => {
        const yaml = `
version: "1"
rules:
  - host: registry.npmjs.org
containers:
  - name: backend
    match:
      image: "node:*"
    egress:
      - host: api.example.com
        methods: [GET, POST]
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            const egress = result.config.containers![0].egress;
            assert.ok(Array.isArray(egress));
            if (Array.isArray(egress)) {
                assert.strictEqual(egress[0].host, 'api.example.com');
                assert.deepStrictEqual(egress[0].methods, ['GET', 'POST']);
            }
        }
    });

    test('parses container with custom secrets array', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: api
    match:
      name: api-server
    secrets:
      - name: db-creds
        type: postgresql
        target: db.example.com:5432
        listenPort: 5432
`;
        const result = parseConfig(yaml);
        assert.ok(result.ok);
        if (result.ok) {
            const secrets = result.config.containers![0].secrets;
            assert.ok(Array.isArray(secrets));
            if (Array.isArray(secrets)) {
                assert.strictEqual(secrets[0].name, 'db-creds');
                assert.strictEqual(secrets[0].type, 'postgresql');
            }
        }
    });

    test('rejects non-array containers', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers: "not an array"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers'));
        }
    });

    test('rejects container without name', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - match:
      image: "node:*"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0].name'));
        }
    });

    test('rejects container without match criteria', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match: {}
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0].match'));
        }
    });

    test('rejects container with invalid match (not an object)', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match: "invalid"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0].match'));
        }
    });

    test('rejects container with invalid egress rules', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match:
      image: "node:*"
    egress:
      - methods: [GET]
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field.includes('containers[0].egress')));
        }
    });

    test('rejects container with invalid egress type', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match:
      image: "node:*"
    egress: "invalid"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0].egress'));
        }
    });

    test('rejects non-object container', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - "just a string"
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0]'));
        }
    });

    test('rejects non-string match.name', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match:
      name: 123
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field === 'containers[0].match.name'));
        }
    });

    test('rejects non-string label values', () => {
        const yaml = `
version: "1"
rules:
  - host: example.com
containers:
  - name: backend
    match:
      label:
        role: 123
`;
        const result = parseConfig(yaml);
        assert.ok(!result.ok);
        if (!result.ok) {
            assert.ok(result.errors.some(e => e.field.includes('match.label')));
        }
    });
});

suite('Container Config Resolution', () => {
    test('resolves containers with egress: true to top-level rules', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            containers: [{
                name: 'backend',
                match: { image: 'node:*' },
                egress: true,
            }],
        };
        const resolved = resolveConfig(config);
        assert.strictEqual(resolved.containers.length, 1);
        assert.deepStrictEqual(resolved.containers[0].rules, resolved.rules);
    });

    test('resolves containers with egress: false to empty rules', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            containers: [{
                name: 'backend',
                match: { image: 'node:*' },
                egress: false,
            }],
        };
        const resolved = resolveConfig(config);
        assert.deepStrictEqual(resolved.containers[0].rules, []);
    });

    test('resolves containers with custom egress rules', () => {
        const customRules = [{ host: 'api.example.com' }];
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            containers: [{
                name: 'backend',
                match: { image: 'node:*' },
                egress: customRules,
            }],
        };
        const resolved = resolveConfig(config);
        assert.deepStrictEqual(resolved.containers[0].rules, customRules);
    });

    test('resolves containers with secrets: true to top-level secrets', () => {
        const topSecrets = [{ name: 'token', type: 'bearer_token' as const, target: 'api.example.com' }];
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            secrets: topSecrets,
            containers: [{
                name: 'backend',
                match: { image: 'node:*' },
                secrets: true,
            }],
        };
        const resolved = resolveConfig(config);
        assert.deepStrictEqual(resolved.containers[0].secrets, topSecrets);
    });

    test('resolves containers with custom secrets array', () => {
        const customSecrets = [{ name: 'db', type: 'postgresql' as const, target: 'db:5432', listenPort: 5432 }];
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            containers: [{
                name: 'backend',
                match: { image: 'node:*' },
                secrets: customSecrets,
            }],
        };
        const resolved = resolveConfig(config);
        assert.deepStrictEqual(resolved.containers[0].secrets, customSecrets);
    });

    test('resolves config without containers to empty containers array', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
        };
        const resolved = resolveConfig(config);
        assert.deepStrictEqual(resolved.containers, []);
    });

    test('resolves multiple containers independently', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            secrets: [{ name: 'token', type: 'bearer_token' as const, target: 'api.example.com' }],
            containers: [
                { name: 'web', match: { name: 'web-*' }, egress: true, secrets: false },
                { name: 'api', match: { name: 'api-*' }, egress: [{ host: 'custom.com' }], secrets: true },
            ],
        };
        const resolved = resolveConfig(config);
        assert.strictEqual(resolved.containers.length, 2);
        assert.deepStrictEqual(resolved.containers[0].rules, resolved.rules);
        assert.deepStrictEqual(resolved.containers[0].secrets, []);
        assert.deepStrictEqual(resolved.containers[1].rules, [{ host: 'custom.com' }]);
        assert.strictEqual(resolved.containers[1].secrets.length, 1);
    });

    test('preserves match criteria in resolved container config', () => {
        const config: EgressorConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            containers: [{
                name: 'worker',
                match: { image: 'python:3', label: { role: 'worker' } },
                egress: true,
            }],
        };
        const resolved = resolveConfig(config);
        assert.strictEqual(resolved.containers[0].name, 'worker');
        assert.strictEqual(resolved.containers[0].match.image, 'python:3');
        assert.deepStrictEqual(resolved.containers[0].match.label, { role: 'worker' });
    });
});

suite('Per-Container Httpjail Rules Generation', () => {
    test('generateHttpjailRulesFromArray generates rules from a rules array', () => {
        const rules = [{ host: 'api.example.com' }, { host: 'cdn.example.com' }];
        const content = generateHttpjailRulesFromArray(rules);
        assert.ok(content.includes('host === "api.example.com"'));
        assert.ok(content.includes('host === "cdn.example.com"'));
        assert.ok(content.includes('||'));
    });

    test('generateHttpjailRulesFromArray returns false for empty rules', () => {
        const content = generateHttpjailRulesFromArray([]);
        assert.ok(content.includes('false'));
        assert.ok(content.includes('No rules configured'));
    });

    test('generatePerContainerHttpjailRules generates one file per container', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            secrets: [],
            containers: [
                { name: 'backend', match: { image: 'node:*' }, rules: [{ host: 'api.example.com' }], secrets: [] },
                { name: 'frontend', match: { name: 'web-*' }, rules: [{ host: 'cdn.example.com' }], secrets: [] },
            ],
        };
        const result = generatePerContainerHttpjailRules(config);
        assert.strictEqual(result.size, 2);
        assert.ok(result.has('backend'));
        assert.ok(result.has('frontend'));
        assert.ok(result.get('backend')!.includes('host === "api.example.com"'));
        assert.ok(result.get('frontend')!.includes('host === "cdn.example.com"'));
    });

    test('generatePerContainerHttpjailRules returns empty map for no containers', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'example.com' }],
            secrets: [],
            containers: [],
        };
        const result = generatePerContainerHttpjailRules(config);
        assert.strictEqual(result.size, 0);
    });

    test('per-container rules with empty rules array generates block-all', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [{ host: 'registry.npmjs.org' }],
            secrets: [],
            containers: [
                { name: 'isolated', match: { name: 'sandbox-*' }, rules: [], secrets: [] },
            ],
        };
        const result = generatePerContainerHttpjailRules(config);
        assert.ok(result.get('isolated')!.includes('false'));
    });
});

suite('Per-Container Secretless Generation', () => {
    test('generateSecretlessYamlFromArray generates YAML from secrets array', () => {
        const secrets = [{ name: 'token', type: 'bearer_token' as const, target: 'api.example.com' }];
        const content = generateSecretlessYamlFromArray(secrets, '/run/secrets');
        assert.ok(content.includes('version:'));
        assert.ok(content.includes('token:'));
    });

    test('generatePerContainerSecretlessYaml generates one file per container with secrets', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [],
            containers: [
                {
                    name: 'api',
                    match: { name: 'api-*' },
                    rules: [],
                    secrets: [{ name: 'db-creds', type: 'postgresql' as const, target: 'db:5432', listenPort: 5432 }],
                },
                {
                    name: 'worker',
                    match: { name: 'worker-*' },
                    rules: [],
                    secrets: [],
                },
            ],
        };
        const result = generatePerContainerSecretlessYaml(config, '/run/secrets');
        // Only the container with secrets should have an entry
        assert.strictEqual(result.size, 1);
        assert.ok(result.has('api'));
        assert.ok(!result.has('worker'));
        assert.ok(result.get('api')!.includes('db-creds'));
    });

    test('generatePerContainerSecretlessYaml returns empty map for no containers', () => {
        const config: ResolvedConfig = {
            version: '1',
            rules: [],
            secrets: [],
            containers: [],
        };
        const result = generatePerContainerSecretlessYaml(config, '/run/secrets');
        assert.strictEqual(result.size, 0);
    });
});

suite('Config Watcher Per-Container Output', () => {
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

    test('writeDerivedConfigs writes per-container httpjail and secretless files', () => {
        const configYaml = `
version: "1"
rules:
  - host: registry.npmjs.org
secrets:
  - name: token
    type: bearer_token
    target: api.example.com
containers:
  - name: backend
    match:
      image: "node:*"
    egress: true
    secrets: true
  - name: frontend
    match:
      name: "web-*"
    egress:
      - host: cdn.example.com
`;
        const writeStub = sinon.stub();
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
            existsSync: sinon.stub().returns(true),
            writeFileSync: writeStub,
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(() => {
            const writtenPaths = writeStub.getCalls().map(c => String(c.args[0]));
            // Top-level files
            assert.ok(writtenPaths.some(p => p.includes('httpjail-rules.js') && !p.includes('httpjail-rules-')));
            assert.ok(writtenPaths.some(p => p.includes('secretless.yml') && !p.includes('secretless-')));
            // Per-container files
            assert.ok(writtenPaths.some(p => p.includes('httpjail-rules-backend.js')));
            assert.ok(writtenPaths.some(p => p.includes('httpjail-rules-frontend.js')));
            assert.ok(writtenPaths.some(p => p.includes('secretless-backend.yml')));
            // frontend has no secrets, so no secretless file for it
            assert.ok(!writtenPaths.some(p => p.includes('secretless-frontend.yml')));
            watcher.dispose();
        });
    });

    test('writeDerivedConfigs skips per-container files when no containers configured', () => {
        const configYaml = `
version: "1"
rules:
  - host: example.com
`;
        const writeStub = sinon.stub();
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
            existsSync: sinon.stub().returns(true),
            writeFileSync: writeStub,
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(() => {
            // Only 1 file: top-level httpjail rules (no secrets configured, no containers)
            assert.strictEqual(writeStub.callCount, 1);
            const writtenPaths = writeStub.getCalls().map(c => String(c.args[0]));
            assert.ok(writtenPaths[0].includes('httpjail-rules.js'));
            watcher.dispose();
        });
    });

    test('per-container httpjail file content matches container rules', () => {
        const configYaml = `
version: "1"
rules:
  - host: registry.npmjs.org
containers:
  - name: api
    match:
      name: "api-*"
    egress:
      - host: custom-api.example.com
`;
        const writeStub = sinon.stub();
        const mockFs = createMockFs({
            readFileSync: sinon.stub().returns(configYaml),
            existsSync: sinon.stub().returns(true),
            writeFileSync: writeStub,
        });

        const callbacks = {
            onConfigChanged: sandbox.stub(),
            onConfigError: sandbox.stub(),
        };
        const watcher = new ConfigWatcher('/workspace', '/workspace/.egressor', callbacks, mockFs);

        return watcher.reload().then(() => {
            const apiRulesCall = writeStub.getCalls().find(c => String(c.args[0]).includes('httpjail-rules-api.js'));
            assert.ok(apiRulesCall, 'Should write per-container rules file for api');
            const content = String(apiRulesCall!.args[1]);
            assert.ok(content.includes('custom-api.example.com'));
            assert.ok(!content.includes('registry.npmjs.org'));
            watcher.dispose();
        });
    });
});
