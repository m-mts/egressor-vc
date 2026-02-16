import * as yaml from 'js-yaml';
import {
    EgressorConfig,
    EgressRule,
    SecretDeclaration,
    ConfigParseResult,
    ConfigValidationError,
    ResolvedConfig,
    HttpMethod,
    SecretType,
    PresetName,
} from './types';

const VALID_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const VALID_SECRET_TYPES: SecretType[] = ['bearer_token', 'header', 'basic_auth', 'postgresql', 'mysql', 'ssh'];
const VALID_PRESETS: PresetName[] = ['node-fullstack', 'python-data-science', 'java-enterprise', 'go-standard', 'web-frontend'];

/** Preset definitions: each preset expands to a set of common egress rules */
const PRESET_RULES: Record<PresetName, EgressRule[]> = {
    'node-fullstack': [
        { host: 'registry.npmjs.org', description: 'npm registry' },
        { host: '*.npmjs.org', description: 'npm CDN' },
        { host: '*.github.com', description: 'GitHub' },
        { host: 'github.com', description: 'GitHub' },
        { host: 'api.github.com', description: 'GitHub API' },
        { host: '*.googleapis.com', description: 'Google APIs' },
    ],
    'python-data-science': [
        { host: 'pypi.org', description: 'PyPI registry' },
        { host: 'files.pythonhosted.org', description: 'PyPI packages' },
        { host: '*.anaconda.org', description: 'Anaconda' },
        { host: 'conda.anaconda.org', description: 'Conda packages' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'java-enterprise': [
        { host: 'repo1.maven.org', description: 'Maven Central' },
        { host: '*.maven.org', description: 'Maven repositories' },
        { host: 'plugins.gradle.org', description: 'Gradle plugins' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'go-standard': [
        { host: 'proxy.golang.org', description: 'Go module proxy' },
        { host: 'sum.golang.org', description: 'Go checksum DB' },
        { host: 'storage.googleapis.com', description: 'Go module storage' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'web-frontend': [
        { host: 'registry.npmjs.org', description: 'npm registry' },
        { host: '*.npmjs.org', description: 'npm CDN' },
        { host: 'cdn.jsdelivr.net', description: 'jsDelivr CDN' },
        { host: 'unpkg.com', description: 'unpkg CDN' },
        { host: '*.cdnjs.cloudflare.com', description: 'cdnjs' },
    ],
};

function validateRule(rule: unknown, index: number): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const prefix = `rules[${index}]`;

    if (typeof rule !== 'object' || rule === null) {
        errors.push({ field: prefix, message: 'Rule must be an object' });
        return errors;
    }

    const r = rule as Record<string, unknown>;

    if (typeof r.host !== 'string' || r.host.trim() === '') {
        errors.push({ field: `${prefix}.host`, message: 'host is required and must be a non-empty string' });
    } else if (!/^\*?\.?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(r.host.trim())) {
        errors.push({ field: `${prefix}.host`, message: 'host must be a valid hostname pattern (alphanumeric, dots, hyphens, optional *. prefix)' });
    }

    if (r.methods !== undefined) {
        if (!Array.isArray(r.methods)) {
            errors.push({ field: `${prefix}.methods`, message: 'methods must be an array' });
        } else {
            for (const m of r.methods) {
                if (!VALID_METHODS.includes(m as HttpMethod)) {
                    errors.push({ field: `${prefix}.methods`, message: `Invalid method: ${m}. Valid: ${VALID_METHODS.join(', ')}` });
                }
            }
        }
    }

    if (r.paths !== undefined) {
        if (!Array.isArray(r.paths)) {
            errors.push({ field: `${prefix}.paths`, message: 'paths must be an array' });
        } else {
            for (const p of r.paths) {
                if (typeof p !== 'string') {
                    errors.push({ field: `${prefix}.paths`, message: 'Each path must be a string' });
                }
            }
        }
    }

    return errors;
}

function validateSecret(secret: unknown, index: number): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const prefix = `secrets[${index}]`;

    if (typeof secret !== 'object' || secret === null) {
        errors.push({ field: prefix, message: 'Secret must be an object' });
        return errors;
    }

    const s = secret as Record<string, unknown>;

    if (typeof s.name !== 'string' || s.name.trim() === '') {
        errors.push({ field: `${prefix}.name`, message: 'name is required and must be a non-empty string' });
    } else if (!/^[a-zA-Z0-9_-]+$/.test(s.name.trim())) {
        errors.push({ field: `${prefix}.name`, message: 'name must contain only alphanumeric characters, hyphens, and underscores' });
    }

    if (!VALID_SECRET_TYPES.includes(s.type as SecretType)) {
        errors.push({ field: `${prefix}.type`, message: `type must be one of: ${VALID_SECRET_TYPES.join(', ')}` });
    }

    if (typeof s.target !== 'string' || s.target.trim() === '') {
        errors.push({ field: `${prefix}.target`, message: 'target is required and must be a non-empty string' });
    }

    if (s.type === 'ssh') {
        errors.push({ field: `${prefix}.type`, message: 'ssh secret type is not yet supported; use bearer_token, header, basic_auth, postgresql, or mysql' });
    }

    if (s.type === 'header' && (typeof s.headerName !== 'string' || s.headerName.trim() === '')) {
        errors.push({ field: `${prefix}.headerName`, message: 'headerName is required for header type secrets' });
    }

    if ((s.type === 'postgresql' || s.type === 'mysql') && (typeof s.listenPort !== 'number' || !Number.isInteger(s.listenPort) || s.listenPort < 1 || s.listenPort > 65535)) {
        errors.push({ field: `${prefix}.listenPort`, message: 'listenPort is required for database connectors and must be an integer 1-65535' });
    }

    return errors;
}

/** Parse raw YAML string into an EgressorConfig with validation */
export function parseConfig(yamlContent: string): ConfigParseResult {
    const errors: ConfigValidationError[] = [];

    let parsed: unknown;
    try {
        parsed = yaml.load(yamlContent);
    } catch (e) {
        return { ok: false, errors: [{ field: 'yaml', message: `Invalid YAML: ${(e as Error).message}` }] };
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, errors: [{ field: 'root', message: 'Config must be a YAML object' }] };
    }

    const doc = parsed as Record<string, unknown>;

    // Version
    if (typeof doc.version !== 'string') {
        errors.push({ field: 'version', message: 'version is required and must be a string' });
    }

    // Presets
    if (doc.presets !== undefined) {
        if (!Array.isArray(doc.presets)) {
            errors.push({ field: 'presets', message: 'presets must be an array' });
        } else {
            for (const p of doc.presets) {
                if (!VALID_PRESETS.includes(p as PresetName)) {
                    errors.push({ field: 'presets', message: `Invalid preset: ${p}. Valid: ${VALID_PRESETS.join(', ')}` });
                }
            }
        }
    }

    // Rules
    if (!Array.isArray(doc.rules)) {
        errors.push({ field: 'rules', message: 'rules is required and must be an array' });
    } else {
        for (let i = 0; i < doc.rules.length; i++) {
            errors.push(...validateRule(doc.rules[i], i));
        }
    }

    // Secrets
    if (doc.secrets !== undefined) {
        if (!Array.isArray(doc.secrets)) {
            errors.push({ field: 'secrets', message: 'secrets must be an array' });
        } else {
            for (let i = 0; i < doc.secrets.length; i++) {
                errors.push(...validateSecret(doc.secrets[i], i));
            }
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        config: {
            version: doc.version as string,
            presets: doc.presets as PresetName[] | undefined,
            rules: doc.rules as EgressRule[],
            secrets: doc.secrets as SecretDeclaration[] | undefined,
        },
    };
}

/** Resolve presets in a config, expanding them into additional rules */
export function resolveConfig(config: EgressorConfig): ResolvedConfig {
    const presetRules: EgressRule[] = [];

    if (config.presets) {
        for (const preset of config.presets) {
            const rules = PRESET_RULES[preset];
            if (rules) {
                presetRules.push(...rules);
            }
        }
    }

    // Merge preset rules with explicit rules, deduplicating by host
    const seenHosts = new Set<string>();
    const mergedRules: EgressRule[] = [];

    // Explicit rules take priority
    for (const rule of config.rules) {
        seenHosts.add(rule.host);
        mergedRules.push(rule);
    }

    // Add preset rules that aren't already covered
    for (const rule of presetRules) {
        if (!seenHosts.has(rule.host)) {
            seenHosts.add(rule.host);
            mergedRules.push(rule);
        }
    }

    return {
        version: config.version,
        rules: mergedRules,
        secrets: config.secrets ?? [],
    };
}

/** Get the rules for a given preset name */
export function getPresetRules(preset: PresetName): EgressRule[] {
    return PRESET_RULES[preset] ?? [];
}
