# Secretless Broker Setup

## Overview

Egressor uses [CyberArk Secretless Broker](https://github.com/cyberark/secretless-broker) to inject credentials into outbound requests without exposing them to the container. The broker runs as a sidecar process, intercepting connections and adding credentials transparently.

Egressor automatically generates `secretless.yml` from the `secrets` section of your `.egressor.yml`. You should not need to edit the generated file directly.

## How .egressor.yml Maps to secretless.yml

Each secret declaration in `.egressor.yml` becomes a service in `secretless.yml`. The mapping depends on the secret type.

### HTTP Secrets

#### bearer_token

```yaml
# .egressor.yml
secrets:
  - name: github_token
    type: bearer_token
    target: api.github.com
```

Generates:

```yaml
# secretless.yml
version: "2"
services:
  github_token:
    protocol: http
    listenOn: "tcp://0.0.0.0:0"
    credentials:
      accessToken:
        from: file
        get: /run/secrets/github_token
    config:
      pattern: api.github.com
```

The broker intercepts HTTP requests to `api.github.com` and adds an `Authorization: Bearer <token>` header.

#### header

```yaml
# .egressor.yml
secrets:
  - name: monitoring_key
    type: header
    target: monitoring.service.com
    headerName: X-API-Key
```

Generates:

```yaml
# secretless.yml
version: "2"
services:
  monitoring_key:
    protocol: http
    listenOn: "tcp://0.0.0.0:0"
    credentials:
      X-API-Key:
        from: file
        get: /run/secrets/monitoring_key
    config:
      pattern: monitoring.service.com
```

#### basic_auth

```yaml
# .egressor.yml
secrets:
  - name: api_creds
    type: basic_auth
    target: api.example.com
```

Generates:

```yaml
# secretless.yml
version: "2"
services:
  api_creds:
    protocol: http
    listenOn: "tcp://0.0.0.0:0"
    credentials:
      username:
        from: file
        get: /run/secrets/api_creds_username
      password:
        from: file
        get: /run/secrets/api_creds_password
    config:
      pattern: api.example.com
```

### Database Secrets

#### postgresql

```yaml
# .egressor.yml
secrets:
  - name: postgres_main
    type: postgresql
    target: db.internal.company.com
    listenPort: 5433
```

Generates:

```yaml
# secretless.yml
version: "2"
services:
  postgres_main:
    protocol: pg
    listenOn: "tcp://0.0.0.0:5433"
    credentials:
      host:
        from: file
        get: /run/secrets/postgres_main_host
      port:
        from: file
        get: /run/secrets/postgres_main_port
      username:
        from: file
        get: /run/secrets/postgres_main_username
      password:
        from: file
        get: /run/secrets/postgres_main_password
    config:
      address: db.internal.company.com
```

Your application connects to `localhost:5433`. The broker proxies the connection to `db.internal.company.com` with the real credentials injected.

#### mysql

```yaml
# .egressor.yml
secrets:
  - name: mysql_analytics
    type: mysql
    target: analytics-db.company.com
    listenPort: 3307
```

Generates:

```yaml
# secretless.yml
version: "2"
services:
  mysql_analytics:
    protocol: mysql
    listenOn: "tcp://0.0.0.0:3307"
    credentials:
      host:
        from: file
        get: /run/secrets/mysql_analytics_host
      port:
        from: file
        get: /run/secrets/mysql_analytics_port
      username:
        from: file
        get: /run/secrets/mysql_analytics_username
      password:
        from: file
        get: /run/secrets/mysql_analytics_password
    config:
      address: analytics-db.company.com
```

### Default Ports

If `listenPort` is omitted (which triggers a validation error), defaults would be:
- PostgreSQL: 5432
- MySQL: 3306

However, `listenPort` is required for database types to avoid port conflicts.

## Credential Storage

Egressor stores secret values in VS Code's SecretStorage API (backed by the OS keychain). When Secretless Broker needs credentials, Egressor writes them to temporary files at `/run/secrets/<name>` that the broker reads via its `file` provider.

### First-Run Prompting

When `.egressor.yml` declares secrets that haven't been stored yet, Egressor prompts you via VS Code input dialogs to provide the values. This happens automatically on first start.

### Managing Secrets

Use VS Code commands to manage stored secrets:

- **Egressor: Store Secret** - Add or update a secret value
- **Egressor: Delete Secret** - Remove a stored secret
- **Egressor: List Secrets** - Show all stored secret names

## SSH Secrets

The `ssh` secret type is declared in the config schema but is handled separately from Secretless Broker services. SSH key management uses direct file-based injection rather than the broker's service proxy model.
