"""Create a deterministic candidate ZIP from reviewed, pinned bytes only."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import stat
import zipfile
from validate import ROOT, selected_bytes, validate, no_aliases, require


def candidate(root=ROOT):
    validate(root)
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(selected_bytes(root).items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, data)
    return out.getvalue()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True, help='existing owned directory for candidate artifacts')
    args = parser.parse_args()
    no_aliases(args.out.absolute())
    require(args.out.is_dir(), 'output must be an existing owned directory')
    data = candidate()
    digest = hashlib.sha256(data).hexdigest()
    target = args.out / ('inventarch-marketplace-' + digest + '.zip')
    # Never truncate a prior report or follow an output link.
    with target.open('xb') as handle:
        handle.write(data)
    print(json.dumps({'path':str(target), 'sha256':digest, 'bytes':len(data),
                      'releaseApproved':False, 'hostQualified':False}))
