import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('owned cache defaults accept the OS temp alias while explicit caller aliases refuse', t => {
  const parent = realpathSync(tmpdir());
  const area = mkdtempSync(join(parent, 'owned-temp-test-'));
  const target = join(area, 'target'), alias = join(area, 'alias');
  mkdirSync(target);
  t.after(() => {
    if (existsSync(alias)) unlinkSync(alias);
    assert.equal(dirname(area), parent);
    assert.equal(realpathSync(area), area);
    rmSync(area, { recursive: true, force: true });
  });
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const module = new URL('../scripts/lib/kit.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { existsSync, lstatSync, realpathSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { userCache } = await import(process.argv[1]);
    const alias = process.argv[2];
    assert.notEqual(tmpdir(), realpathSync(tmpdir()));
    const selected = userCache();
    assert.equal(selected, realpathSync(selected));
    assert.equal(lstatSync(selected).isDirectory(), true);
    assert.throws(() => userCache(alias), /Aliased/);
    assert.throws(() => userCache(join(alias, 'absent')), /Aliased/);
    assert.equal(existsSync(join(alias, 'absent')), false);
    assert.equal(userCache(), selected);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, module, alias], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
});
