import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';

test('Windows PowerShell 5 parses the actual launcher and preserves its Russian messages', {skip:process.platform!=='win32'}, ()=>{
  const root=resolve(import.meta.dirname,'..');
  // ParseFile reads the on-disk encoding used by powershell.exe -File. It does
  // not execute the launcher, read credentials, open SSH or start a browser.
  const probe=`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = Join-Path (Get-Location) 'scripts\\connect-workspace-chatgpt.ps1'
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
[pscustomobject]@{
  version = $PSVersionTable.PSVersion.Major
  errors = @($errors | ForEach-Object { $_.ErrorId })
  strings = @($tokens | Where-Object { $_.Kind -eq 'StringLiteral' } | ForEach-Object { $_.Value })
} | ConvertTo-Json -Compress
`;
  const exe=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(probe,'utf16le').toString('base64')],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status,0,'The native parser probe must complete');
  const parsed=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  assert.equal(parsed.version,5);
  assert.deepEqual(parsed.errors,[]);
  for(const message of [
    'Закрой предыдущее окно помощника ChatGPT и запусти этот файл ещё раз. Локальный порт уже занят.',
    'Войди в ChatGPT в открывшемся браузере. Пароль и коды не нужно пересылать в чат.',
    'После завершения подключения нажми Enter, чтобы закрыть локальное соединение'
  ])assert.ok(parsed.strings.includes(message),'Russian launcher messages must survive native file decoding');
});
