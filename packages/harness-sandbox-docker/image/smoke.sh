#!/bin/sh
# Run on stdin inside the image, under the restrictions documented in README.md.
set -eu
test "$(id -u)" != 0
for tool in sh sleep node base64 find grep stat realpath dirname mkdir rm cat test; do
  command -v "$tool" >/dev/null
done
for tool in npm npx yarn corepack apk git ssh curl gcc cc make; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "Unexpected development or package-management tool: $tool" >&2
    exit 1
  fi
done
test ! -d /usr/local/lib/node_modules
test ! -d /usr/local/include/node
test ! -S /var/run/docker.sock
test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token
test -z "$(find /bin /sbin /usr /lib /opt -xdev -type f -perm /6000 -print)"
test "$(realpath -m -- /workspace/a/../check.txt)" = /workspace/check.txt
mkdir -p /workspace/image-smoke
printf 'aGVsbG8K' | base64 -d > /workspace/image-smoke/check.txt
test "$(base64 < /workspace/image-smoke/check.txt)" = aGVsbG8K
test "$(stat --printf '%s' -- /workspace/image-smoke/check.txt)" = 6
test "$(find /workspace/image-smoke -maxdepth 1 -mindepth 1 -type f -printf '%f')" = check.txt
grep -n -a -E -m 1 -- 'h.llo' /workspace/image-smoke/check.txt >/dev/null
grep -n -H -I --color=never --max-count 1 -F -i -- HELLO /workspace/image-smoke/check.txt >/dev/null
printf 'mounted skill' > /skills/check.txt
printf 'temporary' > /tmp/check.txt
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
assert.equal(await fs.readFile('/workspace/image-smoke/check.txt', 'utf8'), 'hello\n');
assert.equal(spawnSync('cat', ['/skills/check.txt'], { encoding: 'utf8' }).stdout, 'mounted skill');
assert(Object.values(os.networkInterfaces()).flat().every(address => address.internal));
const status = await fs.readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
await assert.rejects(fs.writeFile('/usr/local/bin/image-smoke', ''), { code: 'EROFS' });
console.log('Sandbox image smoke passed');
JS
