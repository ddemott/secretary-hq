/**
 * WHO:   CI + any developer running root `npm test` or an `npm run <script>`
 * WHAT:  `tsx` is a declared, locked root devDependency and resolvable locally
 * WHEN:  every CI run
 * WHERE: package.json, package-lock.json, node_modules/.bin
 * WHY:   ~15 root scripts and 3 test files (`purge-soft-deleted`,
 *        `find-abandoned-test-numbers`, `starterServices`) shell out to
 *        `npx tsx`. With tsx undeclared, npx downloaded it from the registry at
 *        test time: it hung on a clean runner (no TTY for "Ok to proceed?") and
 *        on 2026-09-20 three script tests failed on PR #535 because npm's
 *        "will be installed" warning landed where the test expected the
 *        script's own error text. A network fetch inside a unit test is a flake
 *        waiting for a slow registry.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, unknown>;
};

describe('root tsx dependency', () => {
  it('HAPPY: any root script that runs `npx tsx` has tsx declared in package.json', () => {
    // A real command token: `tsx` / `npx tsx` at the start of a command or after
    // whitespace, NOT a substring like the prettier glob "*.{ts,tsx,js}".
    const usesTsx = Object.values(pkg.scripts).some((cmd) => /(?:^|\s)tsx(?:\s|$)/.test(cmd));
    expect(usesTsx, 'sanity: some root script should use tsx').toBe(true);
    const declared = pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx;
    expect(declared, 'root scripts use tsx but package.json does not declare it').toBeTruthy();
  });

  it('HAPPY: package-lock.json pins tsx so `npm ci` installs it', () => {
    expect(lock.packages['node_modules/tsx']).toBeTruthy();
  });

  it('HAPPY: the local binary exists, so npx never falls back to a registry fetch', () => {
    expect(fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'))).toBe(true);
  });

  it('SAD: the detector ignores tsx inside a glob (prettier "*.{ts,tsx,js}")', () => {
    const detect = (cmd: string) => /(?:^|\s)tsx(?:\s|$)/.test(cmd);
    expect(detect('prettier --check "src/**/*.{ts,tsx,js,jsx}"')).toBe(false);
    expect(detect('npx tsx scripts/foo.ts')).toBe(true);
    expect(detect('tsx scripts/foo.ts')).toBe(true);
  });

  it('SAD: tsx is not accidentally left only in the agent package', () => {
    const agentPkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'agent', 'package.json'), 'utf8')
    ) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    // The agent's own copy does not satisfy root-level `npx tsx` in CI, where
    // the root and agent installs are separate node_modules trees.
    expect(agentPkg.devDependencies?.tsx ?? agentPkg.dependencies?.tsx).toBeTruthy();
    expect(pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx).toBeTruthy();
  });
});
