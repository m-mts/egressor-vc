# Egressor

## See everything. Leak nothing.

**Egressor** is a VS Code extension that gives developers full visibility into what leaves their containers — and stops what shouldn't.

It runs entirely on the host machine, outside the container, where nothing inside the container can see it, tamper with it, or disable it. No malicious dependency, no prompt-injected AI agent, no compromised build script can reach Egressor or the secrets it manages.

Developers get a live, real-time view of every outbound connection their container makes — right inside VS Code, right next to their code.

---

## The Problem

Modern development runs inside containers. DevContainers, Docker, AI coding agents — they all execute code in environments that pull from the internet, talk to APIs, install packages, and run arbitrary scripts.

**Nobody can see what's actually leaving.**

When you run `npm install`, hundreds of packages execute postinstall scripts. When an AI agent writes and runs code, it makes HTTP requests you never review. When a dependency gets compromised (and they do — regularly), it phones home with whatever it can grab.

Today's developer has:
- No visibility into outbound container traffic
- Secrets sitting in environment variables, readable by anything in the container
- No way to control what talks to what at the application layer
- No audit trail of what happened during a session

The tools that exist today either operate at the wrong layer (IP-level firewalls that can't distinguish GET from POST to the same host) or run inside the container (where a compromised process can disable them).

---

## What Egressor Does

### 1. Shows You Everything

Egressor adds a **Traffic Panel** to VS Code's sidebar. Every HTTP/HTTPS request from the container appears here in real-time:

```
 ✅  GET  registry.npmjs.org      /lodash/-/lodash-4.17.21.tgz
 ✅  GET  api.github.com          /repos/myorg/myrepo/contents
 🔴  POST api.github.com          /gists                          ← BLOCKED
 ✅  GET  api.anthropic.com       /v1/messages
 🔒  POST api.stripe.com          /v1/charges                     ← secret injected
```

You see the method, host, path, timing, and outcome. Allowed, blocked, or proxied-with-secret-injection. Color-coded. Filterable. Searchable.

This alone is valuable. Most developers have never seen a complete picture of what their containers are doing on the network.

### 2. Controls What Leaves

Egressor filters outbound traffic using application-layer rules. Not just "allow this domain" — you define what HTTP methods, what paths, what headers are permitted.

A project declares its network needs in a `.egressor.yml` file:

```yaml
egress:
  - name: Package registry
    host: "*.npmjs.org"
    methods: [GET]

  - name: GitHub API
    host: api.github.com
    methods: [GET]

  - name: Stripe API
    host: api.stripe.com
    methods: [GET, POST]
```

Everything not listed is denied. A compromised dependency can't POST your secrets to an unknown server. An AI agent can't create a GitHub Gist to exfiltrate code. A malicious postinstall script can't phone home.

When something is blocked, the developer sees it immediately — in the Traffic Panel, in the Status Bar, and as a VS Code diagnostic. No digging through logs.

### 3. Keeps Secrets Out of Containers

This is the part that changes the security model entirely.

Today, if your app needs a Stripe API key, you put it in an environment variable or a `.env` file. Everything in the container can read it — your app, your tests, your dependencies, your AI agent, and any malicious code that gets in.

Egressor keeps secrets on the host. The container never sees them.

When the container makes a request to `api.stripe.com`, Egressor intercepts it on the host, injects the real API key into the Authorization header, and forwards the request. The container sent a request without credentials. Stripe received a request with credentials. The secret never crossed the container boundary.

The project declares what secrets it needs:

```yaml
secrets:
  - name: STRIPE_SECRET_KEY
    inject_for: api.stripe.com
    as: bearer_token

  - name: DATABASE_URL
    type: postgresql
    listen: localhost:5432
```

The actual values live in the developer's local vault (`~/.egressor/secrets/`), managed through the extension's UI. The `.egressor.yml` only declares *that* a secret exists and *where* it's used — never the value itself. Safe to commit, safe for the agent to read.

### 4. Provides an Audit Trail

After a coding session — especially one involving an AI agent — developers want to know: what just happened?

Egressor keeps a session log:
- Every outbound request (allowed and blocked)
- Every secret injection event (which secret, for which request, when)
- Every rule that fired
- Session summary: "47 requests allowed, 3 blocked, 12 secret injections, 0 anomalies"

This answers questions like:
- "Did my AI agent try to exfiltrate anything?"
- "Which APIs did the test suite actually hit?"
- "Was my Stripe key used during this session, and for what?"

---

## How It Fits Into the Workflow

### For the developer:

1. Install Egressor from the VS Code marketplace
2. Open a project that has a `.egressor.yml`
3. Reopen in Container as usual
4. That's it. Traffic Panel appears. Status Bar shows live stats. Secrets are injected transparently.

There's nothing to configure inside the container. No sidecar to run. No docker-compose changes. No env vars to set. The container doesn't even know Egressor exists.

### For the team lead / security engineer:

1. Add `.egressor.yml` to the repo — declares what the project needs
2. Team members install the extension once
3. Each developer provides their own secret values locally
4. Everyone gets the same egress rules, the same traffic visibility, the same audit trail
5. Update `.egressor.yml` → everyone gets updated rules on next container start

### For the AI agent:

From the agent's perspective, nothing changes. It writes code, runs tests, installs packages, calls APIs. Requests that match the rules go through. Requests that don't get a clear 403 with a reason. Secrets are injected transparently — the agent never needs to know or handle credentials.

The agent cannot:
- Read Egressor's rules (they're on the host, not in the container)
- Read any secret values (they're on the host, never injected into the container environment)
- Disable or reconfigure Egressor (the extension runs in VS Code's host process)
- Detect that Egressor is running (from inside the container, there's just a proxy)

---

## The `.egressor.yml` File

This is the only Egressor artifact that lives in the project repository. It's a declarative manifest — a statement of "what this project needs from the network" — with no sensitive values.

```yaml
# .egressor.yml — committed to git, safe for anyone to read

project: my-fintech-app

# What traffic is allowed out of the container
egress:
  preset: node-fullstack           # sensible defaults for Node.js projects

  allow:
    - name: Stripe API
      host: api.stripe.com
      methods: [GET, POST]
      paths: ["/v1/charges", "/v1/customers", "/v1/payment_intents"]

    - name: GitHub API (read-only)
      host: api.github.com
      methods: [GET]

    - name: Internal service
      host: api.internal.mycompany.com
      methods: [GET, POST, PUT]

  deny:
    - name: Block gist creation
      host: api.github.com
      methods: [POST]
      paths: ["/gists"]

# What secrets the project needs (names only, never values)
secrets:
  - name: STRIPE_SECRET_KEY
    inject_for: api.stripe.com
    as: bearer_token
    description: "Stripe API key — test mode is fine for local dev"

  - name: DATABASE_URL
    type: postgresql
    listen: localhost:5432
    description: "Primary application database"

  - name: GITHUB_TOKEN
    inject_for: api.github.com
    as: bearer_token
    description: "Personal access token — read-only scopes sufficient"
```

When a developer opens this project for the first time, Egressor sees the declared secrets and prompts: "This project needs 3 secrets. Configure them now?" The developer enters values through the extension's secure UI, stored in their local vault, never touching the project directory.

---

## What Makes This Different

**It's outside the container.** Most container security tools run inside the container they're protecting. This is like putting the security guard inside the jail cell. Egressor runs on the host — in a completely separate trust domain from the code it's monitoring.

**It's in the IDE.** Developers don't need a separate dashboard, a terminal window tailing logs, or a browser tab. The information is right there, next to the code, in the tool they're already using.

**It's declarative.** Projects declare what they need. Developers provide their own credentials. The security posture is version-controlled and shared. New team members get the same rules automatically.

**It's invisible to the container.** No environment variables to leak. No config files to tamper with. No processes to kill. From the container's perspective, some requests succeed and some don't — that's all it knows.

**It's useful even without the security story.** Purely as a traffic visibility tool — "show me every HTTP request my container makes" — Egressor is valuable. The security features layer on top of that visibility. This means developers actually want to use it, not just tolerate it.

---

## Use Cases

### AI Coding Agent Safety
You run Claude Code / Cursor / Copilot in a devcontainer with `--dangerously-skip-permissions`. Egressor shows you every outbound request the agent makes. If it tries to POST your code to an unknown server, it's blocked and you see it immediately. The agent can use your Stripe API, GitHub API, and database — but only in the ways you've declared, and it never sees the actual credentials.

### Supply Chain Attack Defense
A compromised npm package runs a postinstall script that tries to exfiltrate your environment variables, npm tokens, or SSH keys. It fails on two levels: the secrets aren't in the container environment (Egressor keeps them on the host), and the outbound request to the attacker's server is blocked (only declared hosts are allowed).

### Development Environment Compliance
Your security team requires that production-like credentials never appear in developer environments. With Egressor, they literally can't — credentials exist only in the host-side vault and are injected at the network layer. The container environment is clean. Audit logs prove it.

### Onboarding
A new developer joins the team, clones the repo, opens it in VS Code. Egressor reads `.egressor.yml`, sees 4 declared secrets, and walks them through providing each one. Five minutes later they're running the full app with all API integrations working — without anyone sending them credentials over Slack.

### Debugging Network Issues
Even without the security features, Egressor's Traffic Panel is a developer tool. "Why is my test hitting the real Stripe API instead of the mock?" Open the Traffic Panel, filter by `stripe.com`, see exactly which test is making the call. No Wireshark, no `tcpdump`, no proxy configuration.

---

## What It Doesn't Do

Egressor is not a general-purpose firewall. It controls HTTP/HTTPS egress from containers. It doesn't handle:
- Raw TCP/UDP connections (non-HTTP protocols) — though it can block them
- DNS tunneling (a dedicated DNS filter layer would be needed for this)
- Container escape prevention (use Docker Desktop's Enhanced Container Isolation for this)
- Code analysis or vulnerability scanning (use existing tools for this)
- Host machine security (Egressor protects what leaves the container, not the host itself)

Egressor also doesn't claim to be unbreakable. A container escape vulnerability that gives an attacker host access would bypass it. The security model assumes container isolation holds — Egressor adds application-layer controls on top of that assumption.

---

## Who This Is For

**Individual developers** who use AI coding agents and want to see what they're doing on the network — and stop anything suspicious.

**Team leads** who want a standardized, shareable security configuration that travels with the repo.

**Security engineers** who want to enforce egress policies and keep secrets out of developer environments without making developers miserable.

**Anyone** who has ever wondered "what is my container actually doing on the network?" and had no good way to find out.
