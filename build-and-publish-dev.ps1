#!/usr/bin/env pwsh
# Hydro 开发版本打包并发布到私有 npm 仓库（PowerShell 版）
#
# 用法:
#   pwsh ./build-and-publish-dev.ps1 -Packages "hydrooj,ui-default"
#   pwsh ./build-and-publish-dev.ps1            # 默认包集合
#   pwsh ./build-and-publish-dev.ps1 -Help

[CmdletBinding()]
param(
    [string]$Packages,
    [switch]$Help,
    [int]$PublishTimeoutSeconds = 300,
    [int]$PublishRetryCount = 3,
    [string]$NpmRegistry = $env:NPM_REGISTRY,
    [string]$YarnApprovedGitRepositories = $env:YARN_APPROVED_GIT_REPOSITORIES
)

$ErrorActionPreference = 'Stop'

if (-not $NpmRegistry) { $NpmRegistry = 'https://npm.leeson.top/' }
if (-not $YarnApprovedGitRepositories) {
    $YarnApprovedGitRepositories = 'https://github.com/Mango/emitter.git'
}
$env:NPM_REGISTRY = $NpmRegistry
$env:YARN_APPROVED_GIT_REPOSITORIES = $YarnApprovedGitRepositories

$DefaultPackages = @('common', 'hydrooj', 'ui-default', 'hydrojudge', 'fps-importer', 'a11y', 'import-hoj')
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
Set-Location $ScriptDir

$script:TsPrepareDone = $false
$script:BuiltTsConfigs = @()
$script:PublishedVersions = @{}
$script:UiAliasThemeCreated = 0
$script:UiAliasHydroCreated = 0
$script:UiAliasThemePath = ''
$script:UiAliasHydroPath = ''

function Write-Section {
    param([string]$Text, [string]$Color = 'Yellow')
    Write-Host ""
    Write-Host $Text -ForegroundColor $Color
}

function Write-Ok    { param([string]$Text) Write-Host $Text -ForegroundColor Green }
function Write-Warn  { param([string]$Text) Write-Host $Text -ForegroundColor DarkYellow }
function Write-Err   { param([string]$Text) Write-Host $Text -ForegroundColor Red }

function Print-Usage {
    Write-Host "用法:"
    Write-Host "  pwsh ./build-and-publish-dev.ps1 [-Packages pkg1,pkg2]"
    Write-Host ""
    Write-Host "可选包名: common, hydrooj, ui-default, hydrojudge, fps-importer, a11y, import-hoj"
    Write-Host "示例:"
    Write-Host "  pwsh ./build-and-publish-dev.ps1 -Packages hydrooj,ui-default"
    Write-Host ""
}

if ($Help) {
    Print-Usage
    exit 0
}

function Get-SelectedPackages {
    param([string]$RawPackages)
    if (-not $RawPackages) { return @($DefaultPackages) }
    $arr = $RawPackages -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($arr.Count -eq 0) { return @($DefaultPackages) }
    # 去重保序
    $seen = @{}
    $result = @()
    foreach ($p in $arr) {
        if (-not $seen.ContainsKey($p)) {
            $seen[$p] = $true
            $result += $p
        }
    }
    return $result
}

function Test-Selected {
    param([string]$Target, [string[]]$Selected)
    foreach ($p in $Selected) { if ($p -eq $Target) { return $true } }
    return $false
}

function Test-Tools {
    Write-Section "1. 检查必要工具..." Yellow
    $missing = @()
    if (-not (Get-Command yarn -ErrorAction SilentlyContinue)) { $missing += 'yarn' }
    if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { $missing += 'npm'  }
    if (-not (Get-Command tar  -ErrorAction SilentlyContinue)) { $missing += 'tar'  }
    if ($missing.Count -gt 0) {
        Write-Err "错误: 缺少必要工具: $($missing -join ', ')"
        exit 1
    }
    Write-Ok "✓ 所有必要工具已安装"
}

function Install-Deps {
    Write-Section "2. 安装依赖..." Yellow
    Set-Location $ScriptDir
    if (-not (Test-Path "node_modules")) {
        yarn install --mode=skip-build
    } else {
        Write-Warn "  node_modules 已存在，跳过安装（如需重装请手动删除 node_modules 后重跑）"
    }
    Write-Ok "✓ 依赖安装完成"
}

function Test-PublishRegistry {
    Write-Section "3. 检查发布仓库和登录状态..." Yellow
    $pingOut = npm ping --registry $NpmRegistry 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "错误: 无法连接到 npm 仓库: $NpmRegistry"
        exit 1
    }
    $whoamiOut = npm whoami --registry $NpmRegistry 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "错误: 当前未登录私有 npm 仓库: $NpmRegistry"
        Write-Warn "请先执行: npm login --registry $NpmRegistry"
        exit 1
    }
    Write-Ok "✓ npm 仓库可访问，且已登录发布账号"
}

function Get-CurrentVersion {
    param([string]$PackagePath)
    $pj = Join-Path $PackagePath 'package.json'
    if (-not (Test-Path $pj)) { return '' }
    $obj = Get-Content $pj -Raw | ConvertFrom-Json
    return $obj.version
}

function Increment-Version {
    param([string]$Version)
    if ($Version -match '^(.+)-dev\.(\d+)$') {
        $base = $matches[1]
        $num  = [int]$matches[2]
        return "$base-dev.$($num + 1)"
    }
    return "$Version-dev.1"
}

function Get-NextDevVersion {
    param([string]$PackageName, [string]$CurrentVersion)
    $candidate = Increment-Version $CurrentVersion
    $base = $CurrentVersion
    $currentNum = 0
    if ($CurrentVersion -match '^(.+)-dev\.(\d+)$') {
        $base = $matches[1]
        $currentNum = [int]$matches[2]
    }
    $remote = ''
    try {
        $remote = (npm view "${PackageName}@dev" version --registry $NpmRegistry 2>$null | Select-Object -First 1).Trim()
    } catch { }
    if ($remote -and $remote -match '^(.+)-dev\.(\d+)$' -and $matches[1] -eq $base) {
        $remoteNum = [int]$matches[2]
        $nextNum = if ($currentNum -gt $remoteNum) { $currentNum + 1 } else { $remoteNum + 1 }
        $candidate = "$base-dev.$nextNum"
    }
    return $candidate
}

function Get-WorkspaceVersion {
    param([string]$Dep)
    switch ($Dep) {
        '@hydrooj/common'    { return Get-CurrentVersion (Join-Path $ScriptDir 'packages/common') }
        '@hydrooj/framework' { return Get-CurrentVersion (Join-Path $ScriptDir 'framework/framework') }
        '@hydrooj/utils'     { return Get-CurrentVersion (Join-Path $ScriptDir 'framework/utils') }
        '@hydrooj/register'  { return Get-CurrentVersion (Join-Path $ScriptDir 'framework/register') }
        default              { return '' }
    }
}

function Fix-WorkspaceDeps {
    param([string]$PackagePath)
    $pj = Join-Path $PackagePath 'package.json'
    if (-not (Test-Path $pj)) { return }
    $deps = @('@hydrooj/common', '@hydrooj/framework', '@hydrooj/utils', '@hydrooj/register')
    foreach ($dep in $deps) {
        $version = Get-WorkspaceVersion $dep
        if (-not $version) { continue }
        $escapedDep = $dep -replace '/', '\\/'
        $pattern = '"' + $escapedDep + '":\s*"workspace:[^"]*"'
        $replacement = '"' + $escapedDep + '": "' + $version + '"'
        $content = Get-Content $pj -Raw
        $content = [regex]::Replace($content, $pattern, $replacement)
        Set-Content -Path $pj -Value $content -NoNewline
    }
}

function Prepare-UIAssetAliases {
    param([string]$PackagePath, [string]$FullVersion)
    $publicDir = Join-Path $PackagePath 'public'
    $baseVersion = $FullVersion -replace '-dev\.\d+$', ''
    $script:UiAliasThemePath = ''
    $script:UiAliasHydroPath = ''
    $script:UiAliasThemeCreated = 0
    $script:UiAliasHydroCreated = 0
    if (-not (Test-Path $publicDir) -or $baseVersion -eq $FullVersion) { return }

    $sourceTheme = Join-Path $publicDir "theme-$baseVersion.css"
    $sourceHydro = Join-Path $publicDir "hydro-$baseVersion.js"
    $targetTheme = Join-Path $publicDir "theme-$FullVersion.css"
    $targetHydro = Join-Path $publicDir "hydro-$FullVersion.js"

    if (-not (Test-Path $sourceTheme)) {
        $sourceTheme = Get-ChildItem -Path $publicDir -File -Filter "theme-$baseVersion-dev.*.css" |
            Sort-Object { [version]($_.BaseName -replace '^.*-dev\.', '') } | Select-Object -Last 1
        if ($sourceTheme) { $sourceTheme = $sourceTheme.FullName }
    }
    if (-not (Test-Path $sourceHydro)) {
        $sourceHydro = Get-ChildItem -Path $publicDir -File -Filter "hydro-$baseVersion-dev.*.js" |
            Sort-Object { [version]($_.BaseName -replace '^.*-dev\.', '') } | Select-Object -Last 1
        if ($sourceHydro) { $sourceHydro = $sourceHydro.FullName }
    }

    $sourceThemeName = if ($sourceTheme) { Split-Path $sourceTheme -Leaf } else { '' }
    $sourceHydroName = if ($sourceHydro) { Split-Path $sourceHydro -Leaf } else { '' }

    Get-ChildItem -Path $publicDir -File -Filter "theme-$baseVersion-dev.*.css" | Where-Object {
        $_.Name -ne "theme-$FullVersion.css" -and $_.Name -ne $sourceThemeName
    } | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $publicDir -File -Filter "hydro-$baseVersion-dev.*.js" | Where-Object {
        $_.Name -ne "hydro-$FullVersion.js" -and $_.Name -ne $sourceHydroName
    } | Remove-Item -Force -ErrorAction SilentlyContinue

    $script:UiAliasThemePath = $targetTheme
    $script:UiAliasHydroPath = $targetHydro

    if ($sourceTheme -and (Test-Path $sourceTheme) -and -not (Test-Path $targetTheme)) {
        Copy-Item -Force $sourceTheme $targetTheme
        $script:UiAliasThemeCreated = 1
    }
    if ($sourceHydro -and (Test-Path $sourceHydro) -and -not (Test-Path $targetHydro)) {
        Copy-Item -Force $sourceHydro $targetHydro
        $script:UiAliasHydroCreated = 1
    }
}

function Remove-UIAssetAliases {
    if ($script:UiAliasThemeCreated -eq 1 -and $script:UiAliasThemePath -and (Test-Path $script:UiAliasThemePath)) {
        Remove-Item -Force $script:UiAliasThemePath
    }
    if ($script:UiAliasHydroCreated -eq 1 -and $script:UiAliasHydroPath -and (Test-Path $script:UiAliasHydroPath)) {
        Remove-Item -Force $script:UiAliasHydroPath
    }
}

function Backup-PackageJson {
    param([string]$PackagePath)
    $pj = Join-Path $PackagePath 'package.json'
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(),
        ([System.IO.Path]::GetFileName($PackagePath) + '-package.json.' + [System.Guid]::NewGuid().ToString('N')))
    Copy-Item $pj $tmp
    return $tmp
}

function Pack-Package {
    param([string]$PackagePath, [string]$TgzFilename)
    $packed = ''
    try {
        $packed = (& npm pack --silent --pack-destination $PackagePath 2>$null | Select-Object -Last 1).Trim()
    } catch { }
    if (-not $packed) { return $false }
    $packedFull = Join-Path $PackagePath $packed
    if (-not (Test-Path $packedFull)) { return $false }
    if ($packed -ne $TgzFilename) {
        $existingTgz = Join-Path $PackagePath $TgzFilename
        if (Test-Path $existingTgz) { Remove-Item -Force $existingTgz }
        Move-Item -Force $packedFull (Join-Path $PackagePath $TgzFilename)
    }
    return $true
}

function Publish-Package {
    param(
        [string]$PackageName,
        [string]$PackagePath,
        [string]$TgzFilename
    )

    Write-Section "处理包: $PackageName" Yellow
    $pj = Join-Path $PackagePath 'package.json'
    if (-not (Test-Path $pj)) {
        Write-Err "错误: 包目录不存在: $PackagePath"
        return $false
    }

    $backup = Backup-PackageJson $PackagePath
    $cleanupActions = @()

    try {
        Fix-WorkspaceDeps $PackagePath

        $currentVersion = Get-CurrentVersion $PackagePath
        $newVersion = Get-NextDevVersion $PackageName $currentVersion
        Write-Host "  版本: $currentVersion -> $newVersion"

        $content = Get-Content $pj -Raw
        $oldVer = '"version": "' + $currentVersion + '"'
        $newVer = '"version": "' + $newVersion + '"'
        $content = $content -replace [regex]::Escape($oldVer), $newVer
        Set-Content -Path $pj -Value $content -NoNewline

        if ($PackageName -eq '@hydrooj/ui-default') {
            Prepare-UIAssetAliases $PackagePath $newVersion
        }

        $tgzFull = Join-Path $PackagePath $TgzFilename
        if (Test-Path $tgzFull) { Remove-Item -Force $tgzFull }

        Write-Host "  正在打包..."
        if (-not (Pack-Package $PackagePath $TgzFilename)) {
            throw "pack failed"
        }
        if (-not (Test-Path $tgzFull)) {
            throw "tgz not found after pack"
        }

        Write-Host "  正在发布到私有 npm 仓库..."
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("publish-temp-" + [System.Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        Push-Location $tempRoot
        try {
            tar -xzf $tgzFull
            Set-Location (Join-Path $tempRoot 'package')
            $safeName = ($PackageName -replace '[/@]', '_')
            $logFile = Join-Path ([System.IO.Path]::GetTempPath()) "npm-publish-$safeName-$newVersion.log"
            $publishOk = $false
            for ($i = 1; $i -le $PublishRetryCount; $i++) {
                Write-Host "  发布尝试 $i/$PublishRetryCount..."
                Remove-Item -Force $logFile -ErrorAction SilentlyContinue
                $proc = Start-Process -FilePath npm -ArgumentList @(
                    'publish', '--registry', $NpmRegistry, '--tag', 'dev'
                ) -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
                  -NoNewWindow -PassThru -WorkingDirectory (Get-Location)
                $exited = $proc.WaitForExit($PublishTimeoutSeconds * 1000)
                if (-not $exited) {
                    try { $proc.Kill() } catch { }
                    Add-Content -Path $logFile -Value "[ps1] publish timeout after $PublishTimeoutSeconds s"
                }
                $contentLog = if (Test-Path $logFile) { Get-Content $logFile -Raw } else { '' }
                $contentErr  = if (Test-Path "$logFile.err") { Get-Content "$logFile.err" -Raw } else { '' }
                $full = $contentLog + "`n" + $contentErr
                Write-Host $full

                if ($proc.ExitCode -eq 0) {
                    $publishOk = $true
                    break
                }
                if ($full -match 'cannot publish over existing version|previously published|forbidden.*version') {
                    Write-Warn "  版本可能已存在，按成功处理"
                    $publishOk = $true
                    break
                }
                if ($i -lt $PublishRetryCount) {
                    Write-Warn "  发布失败，5秒后重试..."
                    Start-Sleep -Seconds 5
                }
            }
            if ($publishOk) {
                Write-Ok "✓ $PackageName@$newVersion 发布成功"
                $script:PublishedVersions[$PackageName] = $newVersion
            } else {
                Write-Warn "⚠ $PackageName 发布失败，详情日志: $logFile"
                if ($PackageName -eq '@hydrooj/ui-default') { Remove-UIAssetAliases }
                return $false
            }
        } finally {
            Pop-Location
            Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Err "错误: $PackageName 处理异常: $_"
        if ($PackageName -eq '@hydrooj/ui-default') { Remove-UIAssetAliases }
        return $false
    } finally {
        if (Test-Path $backup) {
            Copy-Item -Force $backup $pj
            Remove-Item -Force $backup
        }
        if ($PackageName -eq '@hydrooj/ui-default') { Remove-UIAssetAliases }
        Set-Location $ScriptDir
    }

    return $true
}

function Build-TSPackage {
    param([string]$PackageName, [string]$PackagePath)
    $tsconfig = Join-Path $PackagePath 'tsconfig.json'
    if (-not (Test-Path $tsconfig)) {
        Write-Warn "  未找到 tsconfig，跳过 TS 构建: $PackageName"
        return
    }
    if ($script:BuiltTsConfigs -contains $tsconfig) {
        Write-Warn "  已完成 TS 构建，跳过重复构建: $PackageName"
        return
    }
    Set-Location $ScriptDir
    if (-not $script:TsPrepareDone) {
        node build/prepare.js
        $script:TsPrepareDone = $true
    }
    Write-Host "  正在构建: $PackageName (tsc -b $($tsconfig.Substring($ScriptDir.Length + 1)))"
    & ./node_modules/.bin/tsc -b --verbose $tsconfig
    $script:BuiltTsConfigs += $tsconfig
}

function Build-Package {
    param([string]$PackageName, [string]$PackagePath)
    if (-not (Test-Path $PackagePath)) {
        Write-Err "错误: 包目录不存在: $PackagePath"
        return
    }
    if ($PackageName -eq '@hydrooj/ui-default') {
        Write-Host "  正在构建: $PackageName (npm run build:ui)"
        Set-Location $ScriptDir
        npm run build:ui | Out-Null
        $themeFiles = Get-ChildItem -Path (Join-Path $PackagePath 'public') -File -Filter 'theme-*.css' -ErrorAction SilentlyContinue
        $hydroFiles = Get-ChildItem -Path (Join-Path $PackagePath 'public') -File -Filter 'hydro-*.js'  -ErrorAction SilentlyContinue
        if (-not $themeFiles) { Write-Err "错误: ui-default 构建后未找到 theme-*.css"; return }
        if (-not $hydroFiles) { Write-Err "错误: ui-default 构建后未找到 hydro-*.js";  return }
        return
    }
    Build-TSPackage $PackageName $PackagePath
}

# ===== 主流程 =====
$Selected = Get-SelectedPackages $Packages
Write-Host "已选择: $($Selected -join ', ')" -ForegroundColor Green

Test-Tools
Install-Deps
Test-PublishRegistry

Write-Section "4. 开始构建..." Yellow
if (Test-Selected 'common'    $Selected) { Build-Package '@hydrooj/common'   (Join-Path $ScriptDir 'packages/common') }
if (Test-Selected 'hydrooj'   $Selected) { Build-Package 'hydrooj'          (Join-Path $ScriptDir 'packages/hydrooj') }
if (Test-Selected 'ui-default' $Selected) { Build-Package '@hydrooj/ui-default' (Join-Path $ScriptDir 'packages/ui-default') }
if (Test-Selected 'hydrojudge' $Selected) { Build-Package '@hydrooj/hydrojudge' (Join-Path $ScriptDir 'packages/hydrojudge') }
if (Test-Selected 'fps-importer' $Selected) { Build-Package '@hydrooj/fps-importer' (Join-Path $ScriptDir 'packages/fps-importer') }
if (Test-Selected 'a11y' $Selected) { Build-Package '@hydrooj/a11y' (Join-Path $ScriptDir 'packages/a11y') }
if (Test-Selected 'import-hoj' $Selected) { Build-Package '@hydrooj/import-hoj' (Join-Path $ScriptDir 'packages/import-hoj') }

Write-Section "5. 开始打包和发布..." Yellow
$results = @{}
if (Test-Selected 'common'    $Selected) { $results['@hydrooj/common']    = Publish-Package '@hydrooj/common'    (Join-Path $ScriptDir 'packages/common')    'common-dev.tgz' }
if (Test-Selected 'hydrooj'   $Selected) { $results['hydrooj']            = Publish-Package 'hydrooj'            (Join-Path $ScriptDir 'packages/hydrooj')    'hydrooj-dev.tgz' }
if (Test-Selected 'ui-default' $Selected) { $results['@hydrooj/ui-default'] = Publish-Package '@hydrooj/ui-default' (Join-Path $ScriptDir 'packages/ui-default') 'ui-default-dev.tgz' }
if (Test-Selected 'hydrojudge' $Selected) { $results['@hydrooj/hydrojudge'] = Publish-Package '@hydrooj/hydrojudge' (Join-Path $ScriptDir 'packages/hydrojudge') 'hydrojudge-dev.tgz' }
if (Test-Selected 'fps-importer' $Selected) { $results['@hydrooj/fps-importer'] = Publish-Package '@hydrooj/fps-importer' (Join-Path $ScriptDir 'packages/fps-importer') 'fps-importer-dev.tgz' }
if (Test-Selected 'a11y' $Selected) { $results['@hydrooj/a11y'] = Publish-Package '@hydrooj/a11y' (Join-Path $ScriptDir 'packages/a11y') 'a11y-dev.tgz' }
if (Test-Selected 'import-hoj' $Selected) { $results['@hydrooj/import-hoj'] = Publish-Package '@hydrooj/import-hoj' (Join-Path $ScriptDir 'packages/import-hoj') 'import-hoj-dev.tgz' }

Write-Ok "=== 所有包发布完成 ==="
Write-Host ""
Write-Host "已发布的版本:"
foreach ($k in $script:PublishedVersions.Keys) {
    Write-Host ("  - {0}@{1}" -f $k, $script:PublishedVersions[$k])
}
Write-Host ""
Write-Host "安装命令:"
Write-Host "  ./install-dev-from-private-npm.sh" -ForegroundColor Yellow

$failed = $results.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key }
if ($failed) {
    Write-Err "以下包发布失败: $($failed -join ', ')"
    exit 1
}
exit 0
