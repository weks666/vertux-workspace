import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('managed edge preserves inherited guards and rollback through offline Python fixtures', {timeout:15000}, () => {
  const result=spawnSync(process.env.LEAD_TEST_PYTHON || (process.platform==='win32'?'python':'python3'),
    [resolve(import.meta.dirname,'lead-edge-release.test.py')],
    {cwd:resolve(import.meta.dirname,'..'),windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:50000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  const output=(result.stdout||'')+(result.stderr||'');
  assert.ifError(result.error);
  assert.equal(result.status,0,output);
  assert.match(output,/Ran 16 tests/);
  assert.match(output,/\bOK\b/);
});
