#!/usr/bin/env python3
"""Prepare/review/apply the exact 0.1.11 Lead edge overlay through existing SSH.

Default --prepare stages only private files on the host and returns a sanitized
receipt. --activate/--verify/--rollback require that exact prepared receipt and
unchanged local source. No credentials or rendered Caddy bytes are downloaded.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import re
import shlex
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'deploy/lead-edge-overlay.py'
EVIDENCE = ROOT / 'evidence/lead-intelligence'
BOOTSTRAP = r'''
import base64,hashlib,json,re,sys
namespace={"__name__":"vertux_lead_edge_remote","__file__":"<reviewed-edge-source>"}
try:
    request=json.loads(sys.stdin.buffer.read(2000000))
    source=base64.b64decode(request.pop("sourceBase64"),validate=True)
    if hashlib.sha256(source).hexdigest()!=request.get("sourceSha256"):
        raise ValueError("source transfer")
    exec(compile(source,"<reviewed-edge-source>","exec"),namespace)
    result=namespace["operator"](request,source)
    print(json.dumps(result,sort_keys=True))
except Exception as error:
    code="remote_edge_operation_failed"
    if isinstance(error,namespace.get("EdgeError",())) and re.fullmatch(r"[a-z_]+",str(error)):
        code=str(error)
    print(json.dumps({"status":"EDGE_FAILED","reason":code,"secretsPrinted":False}))
    sys.exit(1)
'''


def ssh_command(args):
    for host in (args.host, args.jump_host):
        if host is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host):
            raise ValueError('Invalid existing SSH host')
    if not pathlib.Path(args.key).is_file():
        raise ValueError('Existing SSH key file is missing')
    options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
               '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
    command = ['ssh', *options, '-i', args.key]
    if args.jump_host:
        if (not args.jump_key or not re.fullmatch(r'[A-Za-z0-9_./:\\-]+', args.jump_key)
                or not pathlib.Path(args.jump_key).is_file()):
            raise ValueError('Invalid existing SSH jump key file')
        jump = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
                '-i', args.jump_key.replace('\\', '/'), '-W', '%h:%p', 'root@' + args.jump_host]
        command += ['-o', 'ProxyCommand=' + ' '.join(jump)]
    return [*command, 'root@' + args.host, shlex.join(['python3', '-I', '-c', BOOTSTRAP])]


def make_request(mode, source, receipt=None):
    digest = hashlib.sha256(source).hexdigest()
    request = {'mode': mode, 'sourceSha256': digest, 'sourceBase64': base64.b64encode(source).decode()}
    if mode != 'prepare':
        if (not isinstance(receipt, dict) or receipt.get('kind') != 'vertux.lead-edge-receipt/v1'
                or receipt.get('sourceSha256') != digest or receipt.get('secretsPrinted') is not False
                or not re.fullmatch(r'[0-9a-f]{64}', str(receipt.get('operation', '')))
                or not re.fullmatch(r'[0-9a-f]{64}', str(receipt.get('planSha256', '')))):
            raise ValueError('Prepared receipt or reviewed source changed; prepare the exact candidate again')
        request['receipt'] = receipt
    return request


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='95.181.213.124')
    parser.add_argument('--key', required=True)
    parser.add_argument('--jump-host')
    parser.add_argument('--jump-key')
    modes = parser.add_mutually_exclusive_group()
    for mode in ('prepare', 'activate', 'verify', 'rollback'):
        modes.add_argument('--' + mode, action='store_const', const=mode, dest='mode')
    parser.set_defaults(mode='prepare')
    parser.add_argument('--receipt', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args(argv)
    if args.mode != 'prepare' and args.receipt is None:
        parser.error('--activate, --verify, and --rollback require --receipt from --prepare')
    previous = json.loads(args.receipt.read_text(encoding='utf-8')) if args.receipt else None
    request = make_request(args.mode, SOURCE.read_bytes(), previous)
    result = subprocess.run(ssh_command(args), input=json.dumps(request).encode(), capture_output=True, timeout=240)
    # Ignore remote stderr entirely; Caddy diagnostics may contain ingress data.
    try:
        response = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError('No safe edge receipt returned; use --verify with the prepared receipt') from None
    if result.returncode or response.get('status') == 'EDGE_FAILED':
        code = response.get('reason', '')
        if not isinstance(code, str) or not re.fullmatch(r'[a-z_]+', code):
            code = 'remote_edge_operation_failed'
        raise RuntimeError(code)
    expected = {'prepare': 'EDGE_PREPARED', 'activate': 'EDGE_ACTIVE_VERIFIED',
                'verify': 'EDGE_ACTIVE_VERIFIED', 'rollback': 'EDGE_ROLLED_BACK'}[args.mode]
    if (response.get('kind') != 'vertux.lead-edge-receipt/v1' or response.get('status') != expected
            or response.get('sourceSha256') != request['sourceSha256'] or response.get('secretsPrinted') is not False):
        raise RuntimeError('Unexpected edge receipt')
    destination = args.output or EVIDENCE / ('edge-' + args.mode + '.json')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.tmp')
    temporary.write_text(json.dumps(response, indent=2) + '\n', encoding='utf-8')
    temporary.replace(destination)
    print(json.dumps(response, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Locally generated messages are safe; never print command arguments or
        # captured outputs from a timeout/SSH failure.
        message = str(error) if type(error) in (ValueError, RuntimeError) else 'Edge operation did not return a verified receipt'
        print(json.dumps({'status': 'EDGE_FAILED', 'reason': message, 'secretsPrinted': False}))
        raise SystemExit(1)
