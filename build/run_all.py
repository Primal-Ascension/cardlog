"""Run the whole catalog build in order. Every step is incremental.

Usage:  python run_all.py [--skip-catalog] [--sanity N]
"""
import argparse
import subprocess
import sys

STEPS = ['catalog.py', 'embed.py', 'groups.py', 'variants.py', 'thumbs.py', 'publish.py', 'report.py']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--skip-catalog', action='store_true')
    ap.add_argument('--sanity', type=int, default=0)
    args = ap.parse_args()
    for step in STEPS:
        if step == 'catalog.py' and args.skip_catalog:
            continue
        cmd = [sys.executable, step] + (['--sanity', str(args.sanity)] if step == 'report.py' and args.sanity else [])
        print('==> ' + ' '.join(cmd[1:]), flush=True)
        if subprocess.call(cmd) != 0:
            raise SystemExit('step failed: ' + step)


if __name__ == '__main__':
    main()
