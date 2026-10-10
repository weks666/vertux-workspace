param(
  [string]$Server = '95.181.213.124',
  [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh/supabase_prod_ed25519'),
  [string]$JumpServer = '31.44.4.244',
  [string]$JumpIdentityFile = (Join-Path $env:USERPROFILE '.ssh/vertux_codex_deploy')
)
$ErrorActionPreference = 'Stop'
if ($Server -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid server' }
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw 'Existing SSH connection is required.' }
$sshArguments = @('-N','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=30')
if ($JumpServer) {
  if ($JumpServer -notmatch '^[a-zA-Z0-9.-]+$' -or $JumpIdentityFile -notmatch '^[a-zA-Z0-9_./:\\-]+$' -or -not (Test-Path -LiteralPath $JumpIdentityFile -PathType Leaf)) { throw 'Invalid existing SSH jump connection.' }
  $jumpKey = $JumpIdentityFile.Replace('\','/')
  $sshArguments += @('-o',('"ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -i '+$jumpKey+' -W %h:%p root@'+$JumpServer+'"'))
}
$sshArguments += @('-i',('"'+$IdentityFile+'"'),'-L','127.0.0.1:47922:127.0.0.1:47922',('root@'+$Server))
$connection = $null
try {
  $connection = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArguments -WindowStyle Hidden -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($connection.HasExited) { throw 'Cannot open the protected local connection.' }
    try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:47922/auth/health' -TimeoutSec 2; if ($status.ready) { $ready = $true; break } } catch {}
    Start-Sleep -Milliseconds 300
  }
  if (-not $ready) { throw 'The local sign-in helper is unavailable.' }
  Start-Process 'http://127.0.0.1:47922/'
  Write-Host 'Войди в ChatGPT в открывшемся браузере. Пароль и коды не нужно пересылать в чат.'
  Read-Host 'После завершения подключения нажми Enter, чтобы закрыть локальное соединение' | Out-Null
} finally {
  if ($connection -and -not $connection.HasExited) { Stop-Process -Id $connection.Id }
}
