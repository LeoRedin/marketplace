"""Propose export-selection.json from the shipping rule; write it only with --write, after review.

The rule: both catalogs, plus every file under plugins/<name>/ except its tests (what a Git-based
install copies). The diff against the current selection is printed so a reviewer sees every added,
removed and changed byte before the hashes are recorded. --check exits 1 on any difference, for CI.
validate.py never calls this.
"""
import argparse
import hashlib
import json
import sys
from validate import ROOT, PLUGINS, load, plugin_files, safe_bytes


def proposed(root=ROOT):
    names = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']
    for plugin in PLUGINS:
        names += plugin_files(root, plugin)
    return [{'path': name, 'sha256': hashlib.sha256(safe_bytes(root, name)).hexdigest()} for name in names]


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true', help='record the proposed selection after review')
    mode.add_argument('--check', action='store_true', help='exit 1 if the recorded selection differs from the proposal')
    args = parser.parse_args()
    current = load(ROOT / 'export-selection.json')
    old = {row['path']: row['sha256'] for row in current['files']}
    rows = proposed()
    new = {row['path']: row['sha256'] for row in rows}
    diff = {
        'added': sorted(set(new) - set(old)),
        'removed': sorted(set(old) - set(new)),
        'changed': sorted(p for p in set(old) & set(new) if old[p] != new[p]),
        'files': len(rows),
        'bytes': sum(len(safe_bytes(ROOT, r['path'])) for r in rows),
    }
    print(json.dumps(diff, indent=1))
    if args.write:
        current['files'] = rows
        (ROOT / 'export-selection.json').write_text(json.dumps(current, indent=2) + '\n', encoding='utf-8', newline='\n')
        print('export-selection.json written', file=sys.stderr)
    elif args.check and (diff['added'] or diff['removed'] or diff['changed']):
        print('export-selection.json differs from the shipped files; review the diff, then run with --write', file=sys.stderr)
        sys.exit(1)
