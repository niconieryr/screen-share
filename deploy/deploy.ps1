#!/usr/bin/env pwsh
<#
.SYNOPSIS
  screen-share 部署脚本（幂等）。

.DESCRIPTION
  本地构建 → 渲染配置模板 → 推到 tencent:/srv/screen-share → 起容器 → 自检。

  反复执行结果一致。只新增/覆盖 screen-share 自己的文件，不动这台机器上任何现存
  服务（尤其 AcePanel 和它占用的 80/443）。

.PARAMETER SkipBuild
  跳过前端构建，直接用已有的 www/ 产物（只改服务端配置或令牌时用）。

.PARAMETER HostAlias
  ~/.ssh/config 里的主机别名，默认 tencent。

.EXAMPLE
  ./deploy/deploy.ps1
  ./deploy/deploy.ps1 -SkipBuild          # 只改了 token / 端口
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$HostAlias = 'tencent'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$renderedDir = Join-Path $PSScriptRoot '.rendered'
$remoteDir = '/srv/screen-share'

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Warn2 { param([string]$Text) Write-Host "!!  $Text" -ForegroundColor Yellow }

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments, [string]$What)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（退出码 $LASTEXITCODE）" }
}

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -lt 1) { continue }
        $key = $trimmed.Substring(0, $index).Trim()
        $value = $trimmed.Substring($index + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $map[$key] = $value
    }
    return $map
}

function Render-Template {
    param([string]$TemplatePath, [hashtable]$Values)
    $text = Get-Content -LiteralPath $TemplatePath -Raw
    foreach ($key in $Values.Keys) {
        $text = $text.Replace("__${key}__", [string]$Values[$key])
    }
    $leftover = [regex]::Match($text, '__[A-Z0-9_]+__')
    if ($leftover.Success) {
        throw "$(Split-Path -Leaf $TemplatePath) 里有没替换的占位符：$($leftover.Value)"
    }
    # 模板在 Windows 上编辑，换行统一成 LF 再推上去：
    # nginx 对 CRLF 还算宽容，但 MediaMTX 的 YAML 和 shell 脚本不该赌这个。
    return ($text -replace "`r`n", "`n")
}

# ------------------------------------------------------------------ 1. 配置

$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    throw "找不到 .env。先跑：Copy-Item .env.example .env  然后把两个 token 改掉。"
}

$config = Read-DotEnv -Path $envPath
$required = @(
    'PUBLIC_HOST', 'PUBLIC_PORT', 'ADVERTISE_IP',
    'ROOM', 'VIEW_TOKEN', 'PUBLISH_TOKEN',
    'MTX_HLS_PORT', 'MTX_WEBRTC_PORT', 'MTX_API_PORT', 'MTX_WEBRTC_UDP_PORT'
)
$missing = $required | Where-Object { -not $config.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($config[$_]) }
if ($missing) { throw ".env 里缺少这些键：$($missing -join ', ')" }

if ($config['ROOM'] -notmatch '^[a-z0-9]{6,32}$') {
    throw "ROOM '$($config['ROOM'])' 不合法：只允许小写字母和数字，长度 6-32 位（要和 nginx 正则一致）。"
}
foreach ($key in @('VIEW_TOKEN', 'PUBLISH_TOKEN')) {
    if ($config[$key].Length -lt 16) { throw "$key 太短了，至少 16 位。" }
    if ($config[$key] -match '__') { throw "$key 里不能出现连续下划线（会和模板占位符冲突）。" }
}
if ($config['VIEW_TOKEN'] -eq $config['PUBLISH_TOKEN']) { throw '观看令牌和推流令牌不能是同一个。' }
if ($config['MTX_WEBRTC_UDP_PORT'] -eq '443') {
    throw 'WebRTC 媒体端口不能用 443：AcePanel 的 nginx 已经占了 443/udp（HTTP/3），MediaMTX 绑不上去。'
}

$base = "http://$($config['PUBLIC_HOST']):$($config['PUBLIC_PORT'])"
Write-Step '0/6 检查配置'
Write-Ok "对外 $base，房间 $($config['ROOM'])"

# ------------------------------------------------------------------ 2. 构建

if ($SkipBuild) {
    Write-Step '1/6 跳过构建（-SkipBuild）'
} else {
    Write-Step '1/6 构建前端'
    Push-Location $root
    try {
        Invoke-Checked -Command 'pnpm' -Arguments @('run', 'build') -What '前端构建'
    } finally {
        Pop-Location
    }
}

$wwwDir = Join-Path $root 'www'
if (-not (Test-Path -LiteralPath (Join-Path $wwwDir 'index.html'))) {
    throw "www/index.html 不存在，构建产物没生成。"
}
Write-Ok "产物 $(($(Get-ChildItem $wwwDir -Recurse -File) | Measure-Object).Count) 个文件"

# ------------------------------------------------------------------ 3. 渲染模板

Write-Step '2/6 渲染配置模板'
New-Item -ItemType Directory -Force -Path $renderedDir | Out-Null

$values = @{
    PUBLIC_HOST         = $config['PUBLIC_HOST']
    PUBLIC_PORT         = $config['PUBLIC_PORT']
    # WebRTC 的 ICE 候选用 IP，不用域名 —— 理由见 mediamtx.yml.template
    ADVERTISE_IP        = $config['ADVERTISE_IP']
    # 房间号是固化的：nginx 的正则、MediaMTX 的 paths、前端构建，三处用的是同一个值
    ROOM                = $config['ROOM']
    VIEW_TOKEN          = $config['VIEW_TOKEN']
    PUBLISH_TOKEN       = $config['PUBLISH_TOKEN']
    MTX_HLS_PORT        = $config['MTX_HLS_PORT']
    MTX_WEBRTC_PORT     = $config['MTX_WEBRTC_PORT']
    MTX_API_PORT        = $config['MTX_API_PORT']
    MTX_WEBRTC_UDP_PORT = $config['MTX_WEBRTC_UDP_PORT']
}

$mediamtxOut = Join-Path $renderedDir 'mediamtx.yml'
$nginxOut = Join-Path $renderedDir 'nginx.conf'

Set-Content -LiteralPath $mediamtxOut -Value (Render-Template -TemplatePath (Join-Path $PSScriptRoot 'mediamtx.yml.template') -Values $values) -NoNewline -Encoding utf8
Set-Content -LiteralPath $nginxOut -Value (Render-Template -TemplatePath (Join-Path $PSScriptRoot 'nginx.conf.template') -Values $values) -NoNewline -Encoding utf8

Write-Ok "mediamtx.yml（回环端口 $($config['MTX_HLS_PORT'])/$($config['MTX_WEBRTC_PORT'])/$($config['MTX_API_PORT'])，WebRTC 媒体 UDP $($config['MTX_WEBRTC_UDP_PORT'])）"
Write-Ok 'nginx.conf'

# ------------------------------------------------------------------ 4. 推送

Write-Step '3/6 推送到 tencent'
# /srv 是 root 的，第一次要借 sudo 建目录并交给 polarbear，
# 之后 docker compose 才能以普通用户身份跑。
Invoke-Checked -Command 'ssh' -Arguments @($HostAlias, "sudo mkdir -p $remoteDir/data && sudo chown -R polarbear:polarbear $remoteDir") -What 'ssh 建目录'

# scp 会把 "E:\..." 当成「主机 E + 路径 \...」，所以一律用相对路径推
Push-Location $root
try {
    foreach ($file in @('deploy/.rendered/mediamtx.yml', 'deploy/.rendered/nginx.conf')) {
        Invoke-Checked -Command 'scp' -Arguments @('-q', $file, "${HostAlias}:$remoteDir/") -What "scp $file"
    }
    Invoke-Checked -Command 'scp' -Arguments @('-q', 'docker-compose.yml', "${HostAlias}:$remoteDir/") -What 'scp docker-compose.yml'
    Invoke-Checked -Command 'scp' -Arguments @('-q', 'deploy/remote-install.sh', "${HostAlias}:$remoteDir/") -What 'scp remote-install.sh'
    Write-Ok '配置已推送'

    # 前端产物整目录替换，避免旧 hash 文件堆在服务器上
    Invoke-Checked -Command 'ssh' -Arguments @($HostAlias, "rm -rf $remoteDir/www.new") -What 'ssh 清理旧产物'
    Invoke-Checked -Command 'scp' -Arguments @('-q', '-r', 'www', "${HostAlias}:$remoteDir/www.new") -What 'scp www'
    Invoke-Checked -Command 'ssh' -Arguments @($HostAlias, "rm -rf $remoteDir/www && mv $remoteDir/www.new $remoteDir/www") -What 'ssh 切换产物'
    Write-Ok '前端产物已替换'
} finally {
    Pop-Location
}

# ------------------------------------------------------------------ 5. 远端安装

Write-Step '4/6 远端安装并启动'
$installArgs = "$remoteDir/remote-install.sh $($config['MTX_API_PORT']) $($config['PUBLIC_PORT']) $($config['PUBLIC_HOST']) $($config['MTX_WEBRTC_UDP_PORT'])"
Invoke-Checked -Command 'ssh' -Arguments @($HostAlias, "bash $installArgs") -What '远端安装'

# ------------------------------------------------------------------ 6. 汇总

$watch = "$base/?k=$($config['VIEW_TOKEN'])"
$whip = "$base/whip/$($config['ROOM'])`?k=$($config['PUBLISH_TOKEN'])"

Write-Step '5/6 完成'
Write-Host ''
Write-Host '  观众链接（直接发给别人）' -ForegroundColor Green
Write-Host "    $watch"
Write-Host ''
Write-Host '  OBS 推流（服务选 WHIP，服务器填这条）' -ForegroundColor Green
Write-Host "    $whip"
Write-Host ''
Write-Warn2 'WebRTC 媒体走 UDP，腾讯云安全组入站必须放行'
Write-Warn2 "  UDP $($config['MTX_WEBRTC_UDP_PORT'])（对外的 $($config['PUBLIC_PORT'])/tcp 本来就在安全组里，不用动）"
Write-Warn2 '放行后跑 node scripts/e2e.mjs 验端到端；码率按 docs/OBS-设置.md 里的预设选。'
