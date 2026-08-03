[CmdletBinding()]
param(
    [string]$WorkspaceRoot = '',
    [string]$NexusRoot = '',
    [string]$ExpectedCommit = '',
    [string]$ExpectedNexusCommit = '',
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$releaseName = 'workspace-v17'
$archiveName = "vertux-$releaseName.tar.gz"
$manifestName = "$releaseName.sha256"
$runtimeFiles = @(
    'index.html',
    'styles.css',
    'data.js',
    'auth.js',
    'app.js',
    'sw.js',
    'manifest.webmanifest',
    'nexus-product.json',
    'icon.svg',
    'vendor/supabase.js',
    'vendor/xlsx.full.min.js'
)

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $PSScriptRoot '..'
}
$resolvedRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if ([string]::IsNullOrWhiteSpace($NexusRoot)) {
    $NexusRoot = Join-Path $resolvedRoot '..\projects\vertux-nexus'
}
$resolvedNexusRoot = (Resolve-Path -LiteralPath $NexusRoot).Path
$nginxSourcePath = Join-Path $resolvedNexusRoot 'deploy\nginx-production.conf'
$nexusDeployScriptPath = Join-Path $resolvedNexusRoot 'deploy\deploy-managed-workspace-v17.sh'
$archivePath = Join-Path $PSScriptRoot $archiveName
$manifestPath = Join-Path $PSScriptRoot $manifestName

foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $resolvedRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required Workspace file is missing: $relativePath"
    }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release input must not be a reparse point: $relativePath"
    }
}
foreach ($requiredNexusPath in @($nginxSourcePath, $nexusDeployScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredNexusPath -PathType Leaf)) {
        throw "Required Nexus release file is missing: $requiredNexusPath"
    }
    $item = Get-Item -LiteralPath $requiredNexusPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Nexus release input must not be a reparse point: $requiredNexusPath"
    }
}

& node --check (Join-Path $resolvedRoot 'data.js')
if ($LASTEXITCODE -ne 0) { throw 'data.js syntax check failed.' }
& node --check (Join-Path $resolvedRoot 'auth.js')
if ($LASTEXITCODE -ne 0) { throw 'auth.js syntax check failed.' }
& node --check (Join-Path $resolvedRoot 'app.js')
if ($LASTEXITCODE -ne 0) { throw 'app.js syntax check failed.' }
& node (Join-Path $resolvedRoot 'tests/import-safety.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Workspace import safety tests failed.' }
& node (Join-Path $resolvedRoot 'tests/nexus-contract.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Workspace Nexus contract tests failed.' }

$dirtyRuntime = @(& git -C $resolvedRoot status --porcelain=v1 -- @runtimeFiles)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Workspace Git state.' }
if ($dirtyRuntime.Count -gt 0) {
    throw "Release inputs contain uncommitted changes: $($dirtyRuntime -join ', ')"
}
$sourceCommit = (& git -C $resolvedRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Workspace HEAD is not a full Git commit SHA.'
}
if ($ExpectedCommit -and $ExpectedCommit -ne $sourceCommit) {
    throw "Expected Workspace commit $ExpectedCommit, found $sourceCommit."
}
$dirtyNexusRelease = @(& git -C $resolvedNexusRoot status --porcelain=v1 -- `
    deploy/nginx-production.conf deploy/deploy-managed-workspace-v17.sh)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Nexus Git state.' }
if ($dirtyNexusRelease.Count -gt 0) {
    throw "Nexus release inputs contain uncommitted changes: $($dirtyNexusRelease -join ', ')"
}
$nexusCommit = (& git -C $resolvedNexusRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $nexusCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Nexus HEAD is not a full Git commit SHA.'
}
if ($ExpectedNexusCommit -and $ExpectedNexusCommit -ne $nexusCommit) {
    throw "Expected Nexus commit $ExpectedNexusCommit, found $nexusCommit."
}
$nginxConfigHash = (
    Get-FileHash -LiteralPath $nginxSourcePath -Algorithm SHA256
).Hash.ToLowerInvariant()

$strongSecretPatterns = [ordered]@{
    private_key = '-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----'
    github_token = '\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'
    openai_token = '\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b'
    slack_token = '\bxox[baprs]-[A-Za-z0-9-]{20,}\b'
    aws_access_key = '\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'
    generic_assignment = '(?im)\b(?:api[_-]?key|client[_-]?secret|password|passwd|private[_-]?key|service[_-]?role|token)\b\s*[:=]\s*["''][^"'']{16,}["'']'
}
$jwtPattern = [regex]'(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])'
$scannedFiles = 0
foreach ($relativePath in $runtimeFiles) {
    $content = Get-Content -LiteralPath (Join-Path $resolvedRoot $relativePath) -Raw -Encoding utf8
    foreach ($entry in $strongSecretPatterns.GetEnumerator()) {
        if ($entry.Key -eq 'generic_assignment' -and $relativePath.StartsWith('vendor/')) {
            continue
        }
        if ([regex]::IsMatch($content, $entry.Value)) {
            throw "Secret scan failed in $relativePath ($($entry.Key)); value suppressed."
        }
    }
    foreach ($match in $jwtPattern.Matches($content)) {
        try {
            $payload = $match.Groups[2].Value.Replace('-', '+').Replace('_', '/')
            $payload += '=' * ((4 - ($payload.Length % 4)) % 4)
            $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
        } catch {
            continue
        }
        $allowedPublicAnon = $relativePath -eq 'data.js' `
            -and [string]$json.role -eq 'anon' `
            -and [string]$json.iss -eq 'supabase'
        if (-not $allowedPublicAnon) {
            throw "Secret scan found an unexpected JWT-like value in $relativePath; value suppressed."
        }
    }
    $scannedFiles += 1
}
Write-Host "Secret scan passed: $scannedFiles release files."

if (-not $Force) {
    $existing = @(@($archivePath, $manifestPath) | Where-Object { Test-Path -LiteralPath $_ })
    if ($existing.Count -gt 0) {
        throw "Release output already exists. Review it or pass -Force: $($existing -join ', ')"
    }
}

$runId = [guid]::NewGuid().ToString('N')
$deployRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$stagePath = Join-Path $PSScriptRoot ".workspace-stage-$runId"
$archiveTemp = "$archivePath.$runId.tmp"
$manifestTemp = "$manifestPath.$runId.tmp"
foreach ($temporaryPath in @($stagePath, $archiveTemp, $manifestTemp)) {
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent $temporaryPath)).TrimEnd('\') + '\'
    if (-not $parent.StartsWith($deployRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe temporary path: $temporaryPath"
    }
}

try {
    New-Item -ItemType Directory -Path $stagePath | Out-Null
    $fileHashes = [ordered]@{}
    foreach ($relativePath in $runtimeFiles) {
        $sourcePath = Join-Path $resolvedRoot $relativePath
        $destinationPath = Join-Path $stagePath $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
        $fileHashes[$relativePath.Replace('\', '/')] = (
            Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
    }
    $metadata = [ordered]@{
        schemaVersion = 1
        release = $releaseName
        sourceCommit = $sourceCommit
        nexusCommit = $nexusCommit
        nginxConfigSha256 = $nginxConfigHash
        cacheVersion = 'vertux-workspace-v17'
        files = $fileHashes
    }
    [IO.File]::WriteAllText(
        (Join-Path $stagePath 'release-metadata.json'),
        ($metadata | ConvertTo-Json -Depth 5) + "`n",
        [Text.UTF8Encoding]::new($false)
    )

    $archiveMembers = @($runtimeFiles | ForEach-Object { $_.Replace('\', '/') }) + 'release-metadata.json'
    & tar.exe -czf $archiveTemp -C $stagePath @archiveMembers
    if ($LASTEXITCODE -ne 0) { throw "tar.exe failed with exit code $LASTEXITCODE." }

    $listedMembers = @(& tar.exe -tzf $archiveTemp | ForEach-Object { $_.TrimStart('./') } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Workspace release archive.' }
    $unexpected = @($listedMembers | Where-Object { $_ -notin $archiveMembers })
    $missing = @($archiveMembers | Where-Object { $_ -notin $listedMembers })
    if ($unexpected.Count -gt 0 -or $missing.Count -gt 0) {
        throw "Archive allowlist mismatch. Unexpected=$($unexpected.Count), missing=$($missing.Count)."
    }

    $archiveHash = (Get-FileHash -LiteralPath $archiveTemp -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(
        $manifestTemp,
        "$archiveHash  $archiveName`n$nginxConfigHash  nginx-production.conf`n",
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $archiveTemp -Destination $archivePath -Force:$Force
    Move-Item -LiteralPath $manifestTemp -Destination $manifestPath -Force:$Force
    Write-Host "Prepared $archiveName from Workspace $sourceCommit and Nexus $nexusCommit."
}
finally {
    if (Test-Path -LiteralPath $stagePath) {
        $resolvedStage = [IO.Path]::GetFullPath($stagePath)
        if ($resolvedStage.StartsWith($deployRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    Remove-Item -LiteralPath $archiveTemp, $manifestTemp -Force -ErrorAction SilentlyContinue
}
