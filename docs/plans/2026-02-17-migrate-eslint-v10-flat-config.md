# Migrate ESLint to v10 Flat Config

## Overview

Migrate from the legacy `.eslintrc.json` config format to ESLint v10's flat config format (`eslint.config.mjs`). ESLint v10 is already installed but the project still uses the old `.eslintrc.json` which is no longer supported.

## Context

- Files involved: `.eslintrc.json`, `eslint.config.mjs` (new), `package.json`
- Related patterns: TypeScript project using `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` v8
- Dependencies: Need to add `@eslint/js`, `typescript-eslint` (unified package). Can remove `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` (replaced by unified package).

## Development Approach

- **Testing approach**: Regular (code first, verify with lint)
- Single task since the migration is a straightforward config conversion
- Complete each task fully before moving to the next

## Implementation Steps

### Task 1: Convert to flat config and update dependencies

**Files:**
- Create: `eslint.config.mjs`
- Delete: `.eslintrc.json`
- Modify: `package.json` (scripts and devDependencies)

- [x] Install new dependencies: `npm install --save-dev @eslint/js typescript-eslint`
- [x] Remove old dependencies: `npm uninstall @typescript-eslint/eslint-plugin @typescript-eslint/parser`
- [x] Create `eslint.config.mjs` with flat config format:
  - Import `@eslint/js` for `eslint:recommended`
  - Import `typescript-eslint` for TS recommended rules
  - Migrate custom rules (`semi`, `curly`, `eqeqeq`, `no-throw-literal`, `@typescript-eslint/naming-convention`)
  - Set `ignores` for `out/`, `node_modules/`, `**/*.d.ts`
  - Scope TypeScript config to `src/**/*.ts` files
- [x] Update lint script in package.json from `eslint src --ext ts` to `eslint src/` (flat config handles file matching)
- [x] Delete `.eslintrc.json`
- [x] Run `npm run lint` to verify the migration works correctly
- [x] Fix any lint errors or config issues that arise

### Task 2: Verify acceptance criteria

- [x] Run `npm run lint` -- must pass or show only pre-existing warnings
- [x] Run `npm run compile` -- must pass
- [x] Run `npm run test:unit` -- must pass

### Task 3: Update documentation

- [ ] Update CLAUDE.md if internal patterns changed
- [ ] Move this plan to `docs/plans/completed/`
