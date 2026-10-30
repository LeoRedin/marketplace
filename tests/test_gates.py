import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github' / 'workflows' / 'gates.yml'

# Every command CI runs, in order (AGENTS.md); a dropped or reordered gate fails here, not silently in CI.
RUNS = [
    'git config --global user.name "Gates CI"',
    'git config --global user.email "gates-ci@example.invalid"',
    'npm ci',
    'python tools/validate.py',
    'python tools/selection.py --check',
    'node tools/bundle-kits.mjs --check',
    'node tools/kit.mjs index --check',
    'python tools/consistency.py --base ${{ github.event.pull_request.base.sha || github.event.before }}',
    'npm run lint',
    'node tools/check-language.mjs',
    'python -m unittest discover -s tests -v',
    'node --test "tests/*.test.mjs"',
    'node --test "plugins/*/tests/*.test.mjs"',
    'node tools/run-native-tests.mjs --plan >> "$GITHUB_OUTPUT"',
    'git config --global user.name "Gates CI"',
    'git config --global user.email "gates-ci@example.invalid"',
    'npm ci',
    'node tools/run-native-tests.mjs --shard ${{ matrix.shard }}',
    'node tools/run-native-tests.mjs --verify native-reports/*',
]

# Decision public-ci-matrix.
PULL_REQUEST_OS = ['ubuntu-latest']
PUSH_OS = ['ubuntu-latest', 'windows-latest', 'macos-latest']


class GatesWorkflowTests(unittest.TestCase):
    """Reads gates.yml as text: the standard library has no YAML parser, and the checks need only these lines."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding='utf-8')

    def test_triggers_cover_stacked_pull_requests_and_main_pushes(self):
        self.assertIn("on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n", self.text)

    def test_event_selects_the_operating_systems(self):
        match = re.search(r"os: \$\{\{ github\.event_name == 'push' && fromJSON\('(\[.*?\])'\) \|\| fromJSON\('(\[.*?\])'\) \}\}", self.text)
        self.assertIsNotNone(match, 'the matrix os line has changed shape')
        self.assertEqual(json.loads(match.group(1)), PUSH_OS)
        self.assertEqual(json.loads(match.group(2)), PULL_REQUEST_OS)
        # The native shards and their verify job run on the same operating systems as the gates.
        self.assertEqual(self.text.count(match.group(0)), 3)
        self.assertIn('runs-on: ${{ matrix.os }}', self.text)
        self.assertIn('fail-fast: false', self.text)

    def test_every_gate_is_kept(self):
        self.assertEqual(re.findall(r'^ +run: (.*)$', self.text, re.MULTILINE), RUNS)
        self.assertNotIn('working-directory:', self.text)

    def test_no_gate_may_fail_quietly(self):
        self.assertNotIn('continue-on-error', self.text)
        self.assertEqual(re.findall(r'^ +if: (.*)$', self.text, re.MULTILINE), ['always()', 'always()'])
        self.assertIn('if-no-files-found: error', self.text)

    def test_setup_stays_pinned(self):
        uses = re.findall(r'uses: (\S+)', self.text)
        self.assertEqual(len(uses), 11)
        for action in uses:
            self.assertRegex(action, r'^actions/[a-z-]+@[0-9a-f]{40}$')
        self.assertIn('fetch-depth: 0', self.text)
        self.assertIn("python-version: '3.12'", self.text)
        self.assertIn("node-version: '22.22.0'", self.text)

    def test_native_lane_has_exact_installed_cli(self):
        self.assertIn('IA_CORE_TEST_CLI: ${{ github.workspace }}/node_modules/@inventarch/cli/dist/main.js', self.text)
        inventory = json.loads((ROOT / 'tools/native-inventory.json').read_text(encoding='utf-8'))
        self.assertEqual({case['id'] for case in inventory['cases']}, {'native-releases', 'MI-T04', 'MI-T05', 'native-closure-ownership', 'native-closure-plural-workspaces', 'native-closure-capability-roots', 'native-closure-missing-dependencies', 'native-closure-retention-execution', 'native-closure-executor-refusal', 'native-closure-validation-before-publish', 'native-closure-historical-refusal', 'native-closure-cwd-refusal', 'native-carried-ia-kb', 'native-method-position'})
        self.assertEqual(len({case['id'] for case in inventory['cases']}), len(inventory['cases']))
        for case in inventory['cases']:
            self.assertEqual(case['mode'], 'native')
            self.assertEqual(set(case['platforms']), {'linux', 'win32', 'darwin'})
            self.assertIn(case['shard'], range(1, inventory['shards'] + 1))
        self.assertEqual({case['shard'] for case in inventory['cases']}, set(range(1, inventory['shards'] + 1)))

    def test_checkout_is_lf(self):
        self.assertIn('* text=auto eol=lf', (ROOT / '.gitattributes').read_text(encoding='utf-8').splitlines())


if __name__ == '__main__':
    unittest.main()
