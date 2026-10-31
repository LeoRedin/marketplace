import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMethodClosure, loadMethodClosure } from '../plugins/ia/scripts/lib/method-closure.mjs';
import { attestRuntime } from '../plugins/ia/scripts/lib/closure-runtime.mjs';
import { resolveConsumerSubject } from '../plugins/ia/scripts/lib/closure-native.mjs';
import { runMethodCheck } from '../plugins/ia/scripts/lib/method-check.mjs';
import { writeMethodPin } from '../plugins/ia/scripts/lib/method-pin.mjs';
import { resolveCli } from '../plugins/ia/scripts/lib/cli.mjs';
import { findKit, readRoot } from '../plugins/ia/scripts/lib/kit.mjs';
import { executorSubjectsChanged, prepareExecutor } from '../plugins/ia/scripts/lib/closure-executors.mjs';
import { executeMethodProcess } from '../plugins/ia/scripts/lib/method-process.mjs';

const cli = resolveCli(process.cwd());
function contracts(kit) {
  const name = kit.id.split('/').at(-1).replace(/-kit$/, '');
  return JSON.parse(readFileSync(new URL(`../plugins/ia/config/method-qualification-${name}.json`, import.meta.url), 'utf8')).executionContracts;
}

// ia-kb is the carried kit with a reviewed execution contract for every runner (config/method-qualification-ia-kb.json).
// ia-authoring has none yet: its host-trigger-eval runner has no reviewed executor profile, so it is not qualified here.
for (const kitName of ['ia-kb']) test(`carried ${kitName} retains and executes every declared runner`, async () => {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'carried-method-')));
  try {
    const carried = findKit(kitName), kit = { ...carried, dir: join(directory, 'carried') }, storeRoot = join(directory, 'store');
    cpSync(carried.dir, kit.dir, { recursive: true });
    const closure = await createMethodClosure({ kit, cli, storeRoot, executionContracts: contracts(kit) });
    assert.equal(closure.manifest.checks.length, 4);
    const workspaceRoot = join(directory, 'consumer');
    cpSync(readRoot(kit, { cli }), workspaceRoot, { recursive: true });
    const runtime = await attestRuntime(cli);
    const subject = await resolveConsumerSubject({ root: workspaceRoot, importNative: runtime.importNative });
    // A newer/mutated current kit must not replace the pinned runner bytes.
    writeFileSync(join(kit.dir, 'checks.json'), '{}\n');
    for (const check of closure.manifest.checks) {
      const requiredBy = closure.manifest.capabilities.find(row => row.checks.includes(check.record));
      const capability = requiredBy ?? closure.manifest.capabilities.find(row => row.mode === 'executable');
      const pinRoot = join(directory, check.id), activityKey = 'test.execute';
      const pin = writeMethodPin(pinRoot, { workspace: { identity: subject.identity, revision: subject.revision },
        kits: { [kit.id]: { ...closure.manifest.kit, closureSha256: closure.manifest.closureSha256 } },
        keys: { [activityKey]: { kit: kit.id, capability: capability.identity, profile: capability.profiles[0] ?? null } } }, null);
      const args = {};
      if (check.argumentSchema) {
        cpSync(join(kit.dir, 'assets/examples/split-body/locators.json'), join(workspaceRoot, 'locators.json'));
        args.manifest = 'locators.json';
      }
      const input = { pinRevision: pin.revision, closureSha256: closure.manifest.closureSha256, checkId: check.id, arguments: args, subjectRevision: subject.revision };
      if (!requiredBy) {
        // A sidecar declaration does not add a capability's required check.
        await assert.rejects(runMethodCheck({ input, activityKey, pinRoot, workspaceRoot, cli, storeRoot }), /not required/);
        const output = join(directory, `${check.id}-qualification`); mkdirSync(output);
        const execution = prepareExecutor({ check, closure, workspaceRoot, cli, arguments: args, directory: output });
        const probe = await executeMethodProcess({ ...execution, directory: output, timeoutSeconds: 120,
          env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', IA_CLI_PATH: cli.argv[1], IA_CORE_NO_NPX: '1' } });
        assert.equal(probe.exitCode, 0, readFileSync(join(output, 'stderr.bin'), 'utf8'));
        continue;
      }
      const result = await runMethodCheck({ input, activityKey, pinRoot, workspaceRoot, cli, storeRoot, artifactRoot: join(directory, 'artifacts') });
      assert.equal(result.receipt.exitCode, 0, `${check.id}: ${readFileSync(join(result.artifactDirectory, 'stderr.bin'), 'utf8')}`);
      assert.equal(result.receipt.subjectChanged, false);
      assert.equal(result.receipt.qualification, 'execution-evidence-only');
      if (check.executable === 'node') assert.ok(result.receipt.scriptHelperDigests.length);
      if (check.argumentSchema) {
        assert.equal(result.receipt.subjectInputs[0].path, 'locators.json');
        writeFileSync(join(workspaceRoot, 'locators.json'), '{}');
        assert.equal(executorSubjectsChanged(workspaceRoot, result.receipt.subjectInputs), true);
        const privateInputs = join(directory, 'inputs'); mkdirSync(privateInputs);
        assert.throws(() => prepareExecutor({ check, closure, workspaceRoot, cli, directory: privateInputs, arguments: { manifest: '../escape.json' } }), /Unsafe executor path/);
        assert.throws(() => prepareExecutor({ check, closure, workspaceRoot, cli, directory: privateInputs, arguments: { manifest: 'locators.json', checkout: 'x' } }), /reviewed schema/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
