<#
.SYNOPSIS
  把 screen-share 的两套 OBS profile 预设装进本机 OBS，装完直接在 OBS 里选一下就能推。

.DESCRIPTION
  素材在 deploy/obs/ 下（basic.ini + 两套 streamEncoder.<preset>.json + service.json.template），
  本脚本把它们渲染成两个**独立的** OBS profile，不碰你已有的任何 profile / scene collection。

  装哪两个（名字就是 OBS「配置文件 / Profile」菜单里看到的名字，中文是有意的 ——
  菜单里一眼能看出该选哪个；OBS 本身支持中文 profile 名，自带的「未命名」就是中文）：

    screen-share-3-4人    3-4 人（默认）    1080p20  CBR  700 kbps  Opus 64k  出口 ≈3.3 Mbps
    screen-share-1-2人    1-2 人（画质优先） 1080p30  CBR 1400 kbps  Opus 64k  出口 ≈3.1 Mbps

  两套的区别只有**帧率**和**码率**（basic.ini 里 FPS*、streamEncoder.*.json 里 bitrate），
  其余（NVENC p5 / tune=ll / keyint 2s / bf 0 / lookahead 关 / psycho_aq 关 / repeat_headers）
  完全一致，为什么这么定见 deploy/obs/README.md 和 docs/OBS-设置.md。

  装到哪个目录（不传 -ProfilesDir 就自动探测，探测依据会打印出来）：
    OBS 有两个历史布局，写错地方 OBS 根本看不见：
      %APPDATA%\obs-studio\basic\profiles\<名字>\   ← OBS ≤32（本机 OBS 32.2.2 实测就是这个：
                                                       obs64.exe 里嵌的字符串是 /obs-studio/basic/profiles/，
                                                       user.ini 的 ProfileDir 也落在这一层）
      %APPDATA%\obs-studio\profiles\<名字>\         ← 将来的新布局，存在就用
    探测顺序：① -ProfilesDir ② user.ini 里当前选中的 profile 落在哪个候选目录
    ③ 候选目录里 profile 文件最新修改的那个（OBS 退出时会回写，最能说明谁在真用）
    ④ basic\profiles（非空）⑤ profiles。都不存在就直接报错，不猜。

  令牌：service.json 的推流地址里带 PUBLISH_TOKEN。
    - 给了 -PublishUrl 就用它；否则从项目根 .env 的
      PUBLIC_HOST / PUBLIC_PORT / ROOM / PUBLISH_TOKEN 拼出来
    - 真实令牌只落进 %APPDATA% 下的 profile（仓库外），**不入库、不打印**：
      控制台默认打码（k=4c36…a80e），要看全地址加 -ShowPublishUrl
    - .env 里还是 changeme-* 模板值时给黄色警告，不拦

  安全：要装进 OBS 配置目录时，OBS 在跑就**拒绝执行**（退出码 2）。OBS 退出时会把
  内存里的设置回写 profile，会把刚装的东西盖掉；而且 profile 列表是 OBS 启动时扫的，
  不重启也看不见。请先完全退出 OBS（含托盘图标）再重跑。
  只有一种例外：`-ProfilesDir` 指到 %APPDATA%\obs-studio 之外的目录（临时目录、
  沙箱、CI 自检）时照装不误 —— OBS 既不读也不写那里，装了也不会出现在菜单里，
  脚本会明确提示这一点。
  只动自己这两个目录：不写 user.ini / global.ini，不动 basic\scenes\*，
  也不动别人的 profile 目录。同名目录若**不是**本脚本装的（没有归属标记），
  先整目录改名成 <名字>.bak-<时间戳> 备份，再装 —— 绝不静默覆盖别人的东西。

  幂等：内容一致的文件不重写（OBS 自己回写过的会被纠正回来），重复执行结果一致。

.EXAMPLE
  ./scripts/install-obs-profile.ps1

.EXAMPLE
  ./scripts/install-obs-profile.ps1 -ShowPublishUrl

.EXAMPLE
  ./scripts/install-obs-profile.ps1 -PublishUrl 'http://1.2.3.4:8443/whip/share01?k=<推流令牌>'

.NOTES
  语法自检：
    pwsh -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/install-obs-profile.ps1',[ref]$null,[ref]$errs); $errs"
  本文件是 UTF-8 无 BOM，请用 PowerShell 7（pwsh）跑，Windows PowerShell 5.1 下中文会乱码。
#>
[CmdletBinding()]
param(
    # 完整推流地址（含令牌）。给了就不再读 .env。
    [string]$PublishUrl,

    # auto = 端口 443 用 https，其余用 http（本项目是明文 http + IP 端口）。
    [ValidateSet('auto', 'http', 'https')]
    [string]$Scheme = 'auto',

    # 强制指定 profile 根目录（默认自动探测，见 .DESCRIPTION）。
    [string]$ProfilesDir,

    # 打印完整推流地址（默认打码，避免令牌出现在录屏/日志里）。
    [switch]$ShowPublishUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 让中文在pwsh/老控制台里都尽量正常（换行被重定向等场景会抛，忽略即可）
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

function Write-Step { param([string]$Text) Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }
function Write-Good { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    ! $Text" -ForegroundColor Yellow }
function Fail {
    param([string]$Text, [int]$Code = 1)
    Write-Host ''
    Write-Host "!! $Text" -ForegroundColor Red
    Write-Host ''
    exit $Code
}

# 只在真的要用到时才读 .env（.env 里是真实令牌，能少读一次是一次）
function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $index = $trimmed.IndexOf('=')
        if ($index -lt 1) { continue }
        $key = $trimmed.Substring(0, $index).Trim()
        $value = $trimmed.Substring($index + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]; $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $map[$key] = $value
    }
    return $map
}

function Get-IniValue {
    param([string]$Text, [string]$Section, [string]$Key)
    $current = ''
    foreach ($line in ($Text -split "`r?`n")) {
        $trim = $line.Trim()
        if ($trim -match '^\[(.+)\]$') { $current = $Matches[1]; continue }
        if ($current -eq $Section -and $trim -match "^$([regex]::Escape($Key))\s*=\s*(.*)$") {
            return $Matches[1].Trim()
        }
    }
    return $null
}

# 只改指定 section 里的 key，其它行（含注释、顺序、缩进）原样保留；section 不存在就补一个
function Set-IniValue {
    param([string]$Text, [string]$Section, [string]$Key, [string]$Value)
    $eol = if ($Text -match "`r`n") { "`r`n" } else { "`n" }
    $lines = $Text -split "`r?`n"
    $out = [System.Collections.Generic.List[string]]::new()
    $current = ''
    $sectionSeen = $false
    $wrote = $false
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim -match '^\[(.+)\]$') {
            $next = $Matches[1]
            if ($current -eq $Section -and -not $wrote) { $out.Add("$Key=$Value"); $wrote = $true }
            $current = $next
            if ($next -eq $Section) { $sectionSeen = $true }
            $out.Add($line)
            continue
        }
        if ($current -eq $Section -and $trim -match "^$([regex]::Escape($Key))\s*=") {
            $out.Add("$Key=$Value"); $wrote = $true; continue
        }
        $out.Add($line)
    }
    if ($current -eq $Section -and -not $wrote) { $out.Add("$Key=$Value"); $wrote = $true }
    if (-not $sectionSeen) {
        if ($out.Count -gt 0 -and $out[$out.Count - 1] -ne '') { $out.Add('') }
        $out.Add("[$Section]")
        $out.Add("$Key=$Value")
    }
    return ($out -join $eol)
}

# 写入并返回 $true（改了）/ $false（内容一致，跳过）
function Sync-TextFile {
    param([string]$Path, [string]$Content)
    if (Test-Path -LiteralPath $Path) {
        $existing = Get-Content -LiteralPath $Path -Raw
        if ($null -eq $existing) { $existing = '' }
        # BOM 和换行风格不算差异：OBS 回写时会加 BOM，不该因此触发重写
        $existing = $existing.TrimStart([char]0xFEFF) -replace "`r`n", "`n"
        $wanted = $Content.TrimStart([char]0xFEFF) -replace "`r`n", "`n"
        if ($existing -ceq $wanted) { return $false }
    }
    Set-Content -LiteralPath $Path -Value $Content -NoNewline -Encoding utf8
    return $true
}

# 令牌打码：http://host:8443/whip/room?k=4c36…a80e
function Protect-Url {
    param([string]$Url)
    $mark = $Url.IndexOf('?')
    if ($mark -lt 0) { return $Url }
    $base = $Url.Substring(0, $mark + 1)
    $parts = @()
    foreach ($part in ($Url.Substring($mark + 1) -split '&')) {
        if ($part -match '^k=(.+)$') {
            $token = $Matches[1]
            if ($token.Length -gt 12) {
                $parts += "k=$($token.Substring(0, 4))…$($token.Substring($token.Length - 4))（$($token.Length) 位）"
            } else {
                $parts += 'k=…'
            }
        } else {
            $parts += $part
        }
    }
    return $base + ($parts -join '&')
}

# ---------------------------------------------------------------- 0/4 环境

Write-Step '0/4 检查环境'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Warn "当前是 Windows PowerShell $($PSVersionTable.PSVersion)，中文可能乱码，建议用 pwsh 跑"
}

$root = Split-Path -Parent $PSScriptRoot
$obsAssets = Join-Path $root 'deploy\obs'
$obsConfigRoot = Join-Path $env:APPDATA 'obs-studio'

$assetFiles = @('basic.ini', 'streamEncoder.default.json', 'streamEncoder.quality.json', 'service.json.template')
foreach ($name in $assetFiles) {
    $p = Join-Path $obsAssets $name
    if (-not (Test-Path -LiteralPath $p)) { Fail "缺少 OBS 素材：$p（这个文件应该在仓库里，别删）" }
}
Write-Ok "OBS 素材 $obsAssets"

# 先看 OBS 在不在跑（下面探测出目标目录之后才决定拦不拦）
$running = @()
foreach ($procName in @('obs64', 'obs32', 'obs')) {
    $procs = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
    foreach ($p in $procs) { $running += "$($p.ProcessName) (PID $($p.Id))" }
}

# profile 根目录探测：两个历史布局，写错了 OBS 看不见
$candidates = @(
    [pscustomobject]@{ Key = 'basic'; Path = (Join-Path $obsConfigRoot 'basic\profiles'); Layout = 'OBS ≤32 布局：obs-studio\basic\profiles' },
    [pscustomobject]@{ Key = 'new';   Path = (Join-Path $obsConfigRoot 'profiles');       Layout = '新布局：obs-studio\profiles' }
)

$profilesRoot = $null
$why = $null

if ($ProfilesDir) {
    if (-not (Test-Path -LiteralPath $ProfilesDir)) {
        Fail "指定的 -ProfilesDir 不存在：$ProfilesDir"
    }
    $profilesRoot = (Resolve-Path -LiteralPath $ProfilesDir).Path
    $why = '命令行 -ProfilesDir 指定'
} else {
    $existing = @($candidates | Where-Object { Test-Path -LiteralPath $_.Path })
    if ($existing.Count -eq 0) {
        $paths = ($candidates | ForEach-Object { $_.Path }) -join '  ;  '
        Fail "没找到 OBS 的 profile 目录（两个布局都不存在）：$paths —— OBS 装了吗？装完至少启动过一次吗？也可以用 -ProfilesDir 手动指。"
    }

    # ① user.ini 里当前选中的 profile 落在哪个候选里 —— 最硬的证据
    $userIni = Join-Path $obsConfigRoot 'user.ini'
    if (Test-Path -LiteralPath $userIni) {
        $profileDir = Get-IniValue -Text (Get-Content -LiteralPath $userIni -Raw) -Section 'Basic' -Key 'ProfileDir'
        if ($profileDir) {
            foreach ($c in $existing) {
                if (Test-Path -LiteralPath (Join-Path $c.Path $profileDir)) {
                    $profilesRoot = $c.Path
                    $why = "user.ini 里当前选中的 profile「$profileDir」就在这一层"
                    break
                }
            }
        }
    }

    # ② profile 文件最新修改的那个（OBS 退出时回写，最能说明谁在真用）
    if (-not $profilesRoot -and $existing.Count -gt 1) {
        $newest = $null
        $newestAt = [datetime]::MinValue
        foreach ($c in $existing) {
            $files = @(Get-ChildItem -LiteralPath $c.Path -Recurse -File -ErrorAction SilentlyContinue)
            if ($files.Count -eq 0) { continue }
            $at = ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
            if ($at -gt $newestAt) { $newestAt = $at; $newest = $c }
        }
        if ($newest) {
            $profilesRoot = $newest.Path
            $why = "里面的 profile 文件最新（$($newestAt.ToString('yyyy-MM-dd HH:mm'))），OBS 在用它"
        }
    }

    # ③ basic\profiles 非空；④ 兜底
    if (-not $profilesRoot) {
        $basic = $existing | Where-Object { $_.Key -eq 'basic' } | Select-Object -First 1
        if ($basic -and @(Get-ChildItem -LiteralPath $basic.Path -Directory -ErrorAction SilentlyContinue).Count -gt 0) {
            $profilesRoot = $basic.Path
            $why = 'basic\profiles 下有现成的 profile 目录'
        }
    }
    if (-not $profilesRoot) {
        $profilesRoot = ($existing | Select-Object -First 1).Path
        $why = ($existing | Select-Object -First 1).Layout
    }
}

Write-Ok "OBS 配置根目录 $obsConfigRoot"
Write-Good "profile 目录 $profilesRoot"
Write-Ok "为什么是它：$why"
foreach ($c in $candidates) {
    if ($c.Path -ne $profilesRoot -and (Test-Path -LiteralPath $c.Path)) {
        Write-Ok "（另一个布局也在，但没选它：$($c.Path) —— 要改就传 -ProfilesDir）"
    }
}

# OBS 在跑 + 目标是 OBS 配置目录 → 拒绝：OBS 退出时会把内存里的设置回写 profile，把刚装的盖掉。
# 目标在 OBS 配置目录之外（-ProfilesDir 指到临时目录，沙箱/导出用）时 OBS 既不读也不写，
# 放行并说清楚 —— 那种目录不会出现在 OBS 菜单里。
$targetInsideObs = $profilesRoot.StartsWith($obsConfigRoot, [System.StringComparison]::OrdinalIgnoreCase)
if ($running.Count -gt 0 -and $targetInsideObs) {
    Write-Host ''
    Write-Host "!! OBS 正在运行：$($running -join '、')" -ForegroundColor Red
    Write-Host ''
    Write-Host '   OBS 退出时会把内存里的设置整个回写 profile，会把刚装好的参数盖掉，' -ForegroundColor Yellow
    Write-Host '   所以脚本拒绝执行（不是 bug，是故意的）。请：' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '     1. 完全退出 OBS —— 包括右下角托盘图标上右键退出'
    Write-Host '     2. 确认任务管理器里没有 obs64.exe'
    Write-Host '     3. 重跑：./scripts/install-obs-profile.ps1'
    Write-Host ''
    Write-Host '   （profile 列表是 OBS 启动时扫的，反正也得重启 OBS 才能在菜单里看到新 profile）' -ForegroundColor DarkGray
    Write-Host ''
    exit 2
}
if ($running.Count -gt 0) {
    Write-Warn "OBS 正在运行（$($running -join '、')），但目标目录在 OBS 配置目录之外，OBS 既不读也不覆盖它 —— 继续（这种目录不会出现在 OBS 菜单里）"
} else {
    Write-Good 'OBS 没在运行（可以安全写 profile）'
}

# ---------------------------------------------------------------- 1/4 推流地址

Write-Step '1/4 取推流地址（含令牌，只会写进 OBS profile）'

if ($PublishUrl) {
    $whipUrl = $PublishUrl.Trim()
    Write-Ok '来源：命令行 -PublishUrl'
} else {
    $envPath = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        Fail "找不到 $envPath。先 Copy-Item .env.example .env 并填好两个令牌（或者直接传 -PublishUrl）。"
    }
    $config = Read-DotEnv -Path $envPath
    foreach ($key in @('PUBLIC_HOST', 'PUBLIC_PORT', 'ROOM', 'PUBLISH_TOKEN')) {
        if (-not $config.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($config[$key])) {
            Fail "$envPath 里缺少 $key"
        }
    }

    $port = $config['PUBLIC_PORT']
    $useScheme = switch ($Scheme) {
        'http'  { 'http' }
        'https' { 'https' }
        default { if ($port -eq '443') { 'https' } else { 'http' } }
    }
    $defaultPort = if ($useScheme -eq 'https') { '443' } else { '80' }
    $authority = if ($port -eq $defaultPort) { $config['PUBLIC_HOST'] } else { "$($config['PUBLIC_HOST']):$port" }
    $whipUrl = "$useScheme`://$authority/whip/$($config['ROOM'])`?k=$($config['PUBLISH_TOKEN'])"
    Write-Ok "来源：$envPath（PUBLIC_HOST / PUBLIC_PORT / ROOM / PUBLISH_TOKEN）"

    if ($whipUrl -match 'changeme') {
        Write-Warn '.env 里还是 changeme-* 模板值，先把两个令牌换成随机值再装（现在装的地址推不上去）'
    }
}

if ($whipUrl -notmatch '^https?://[^/]+/.+') {
    Fail "推流地址不像话：$(Protect-Url $whipUrl)（要形如 http://host:port/whip/<房间>?k=<令牌>）"
}
if (-not $ShowPublishUrl) {
    Write-Ok "推流地址 $(Protect-Url $whipUrl)   ← 已打码，-ShowPublishUrl 看全"
}

# ---------------------------------------------------------------- 2/4 写入

# 两套预设的差异只有帧率和码率。码率从 streamEncoder.<id>.json 里读，不在这儿重复写死
$presets = @(
    [pscustomobject]@{
        Name     = 'screen-share-3-4人'
        Id       = 'default'
        Summary  = '3-4 人（默认）'
        Fps      = 20
        Encoder  = 'streamEncoder.default.json'
    },
    [pscustomobject]@{
        Name     = 'screen-share-1-2人'
        Id       = 'quality'
        Summary  = '1-2 人（画质优先）'
        Fps      = 30
        Encoder  = 'streamEncoder.quality.json'
    }
)

# 素材**全部读完验完再动盘**，免得写到一半才发现素材坏了
foreach ($preset in $presets) {
    $encoderRaw = Get-Content -LiteralPath (Join-Path $obsAssets $preset.Encoder) -Raw
    $encoderObj = $encoderRaw | ConvertFrom-Json
    $bitrate = [int]$encoderObj.bitrate
    if (-not $bitrate) { Fail "$($preset.Encoder) 里没有 bitrate" }
    if ($encoderObj.rate_control -ne 'CBR') {
        Write-Warn "$($preset.Encoder) 的 rate_control 不是 CBR：码率会飘，出口带宽就没法估了"
    }
    if ([int]$encoderObj.bf -ne 0) {
        Write-Warn "$($preset.Encoder) 的 bf 不是 0：浏览器实现 WebRTC 时刻意不支持 H.264 的 B 帧，观众会只出声不出画"
    }
    if (-not [bool]$encoderObj.repeat_headers) {
        Write-Warn "$($preset.Encoder) 的 repeat_headers 不是 true：中途加入的观众要等下一个关键帧才有画面"
    }
    $preset | Add-Member -NotePropertyName EncoderRaw -NotePropertyValue $encoderRaw
    $preset | Add-Member -NotePropertyName Bitrate -NotePropertyValue $bitrate
    # 汇报里的数值也从素材里取，别在打印语句里写死 —— 素材改了打印就会撒谎
    $preset | Add-Member -NotePropertyName Keyint -NotePropertyValue $encoderObj.keyint_sec
    $preset | Add-Member -NotePropertyName EncoderPreset -NotePropertyValue $encoderObj.preset
    $preset | Add-Member -NotePropertyName Tune -NotePropertyValue $encoderObj.tune
}

$basicTemplate = Get-Content -LiteralPath (Join-Path $obsAssets 'basic.ini') -Raw
$serviceTemplate = Get-Content -LiteralPath (Join-Path $obsAssets 'service.json.template') -Raw

# 音频那几项也从 basic.ini 里取，汇报和真话保持一致
$audioEncoder = Get-IniValue -Text $basicTemplate -Section 'AdvOut' -Key 'AudioEncoder'
$audioKbps = Get-IniValue -Text $basicTemplate -Section 'AdvOut' -Key 'Track1Bitrate'
$audioRate = Get-IniValue -Text $basicTemplate -Section 'Audio' -Key 'SampleRate'
$audioChannel = Get-IniValue -Text $basicTemplate -Section 'Audio' -Key 'ChannelSetup'

if ((Get-IniValue -Text $basicTemplate -Section 'Output' -Key 'Mode') -ne 'Advanced') {
    Write-Warn 'basic.ini 不是 Advanced 输出模式：Simple 模式下改不了关键帧间隔，HLS 兜底的观众要等很久才出画'
}
$placeholderCount = ([regex]::Matches($serviceTemplate, [regex]::Escape('__WHIP_URL__'))).Count
if ($placeholderCount -ne 1) {
    Fail "service.json.template 里的 __WHIP_URL__ 出现了 $placeholderCount 次（应该正好 1 次）"
}
$serviceJson = $serviceTemplate.Replace('__WHIP_URL__', $whipUrl)
if ($serviceJson -match '__[A-Z0-9_]+__') {
    Fail 'service.json.template 里还有没替换的占位符'
}
$null = $serviceJson | ConvertFrom-Json   # 顺手验一下替完还是合法 JSON

# 归属标记：用来判断这个目录是不是本脚本装的（OBS 不认识这个文件，放着不影响）
# 用 [ordered] 而不是普通哈希表：哈希表的键顺序在进程之间不稳定，会让标记文件
# 每次生成的字节都不一样，幂等就没了（-- 这个坑是跑第二遍时发现的）
function Get-Marker {
    param([string]$PresetId, [string]$PresetName, [int]$Fps, [int]$Bitrate)
    return ([ordered]@{
        project     = 'screen-share'
        generatedBy = 'scripts/install-obs-profile.ps1'
        preset      = $PresetId
        profileName = $PresetName
        fps         = $Fps
        videoKbps   = $Bitrate
        note        = '本文件由 install-obs-profile.ps1 写入，用于判断这个 profile 目录归本项目管；删掉不影响 OBS，但下次装会当成别人的同名 profile 备份一次。'
    } | ConvertTo-Json -Depth 4) + "`n"
}
$markerName = '.screen-share-profile.json'

Write-Step '2/4 写入 profile'
$installed = @()

foreach ($preset in $presets) {
    $target = Join-Path $profilesRoot $preset.Name
    $marker = Join-Path $target $markerName
    $isOurs = Test-Path -LiteralPath $marker
    $existedBefore = Test-Path -LiteralPath $target

    if ($existedBefore -and -not $isOurs) {
        # 同名但不是我们装的 —— 绝不静默覆盖，整目录备份一次
        $backup = "$target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Move-Item -LiteralPath $target -Destination $backup
        Write-Warn "同名目录不是本脚本装的，已整体备份到 $(Split-Path -Leaf $backup)"
        $existedBefore = $false
    }
    if (-not $existedBefore) { New-Item -ItemType Directory -Force -Path $target | Out-Null }

    # basic.ini：改 Name（OBS 的 profile 名就写在这儿，目录名和它必须一致）
    # 和帧率（两套预设只差帧率 + 码率）
    $basic = Set-IniValue -Text $basicTemplate -Section 'General' -Key 'Name' -Value $preset.Name
    $basic = Set-IniValue -Text $basic -Section 'Video' -Key 'FPSCommon' -Value $preset.Fps
    $basic = Set-IniValue -Text $basic -Section 'Video' -Key 'FPSInt' -Value $preset.Fps
    $basic = Set-IniValue -Text $basic -Section 'Video' -Key 'FPSNum' -Value $preset.Fps
    $basic = Set-IniValue -Text $basic -Section 'Video' -Key 'FPSDen' -Value 1

    # 码率以预读好的 streamEncoder.<id>.json 为准
    $encoderRaw = $preset.EncoderRaw
    $bitrate = $preset.Bitrate

    # SimpleOutput 只在 Simple 模式下生效，但一起改成同一个码率，
    # 免得哪天有人切回 Simple 模式，码率和 Advanced 对不上
    $basic = Set-IniValue -Text $basic -Section 'SimpleOutput' -Key 'VBitrate' -Value $bitrate

    $files = [ordered]@{
        # 文件名必须是 streamEncoder.json —— 这是 OBS 读的固定名字，
        # 仓库里那两个名字（.default/.quality）只是给两套预设编号用的
        'basic.ini'                  = $basic
        'streamEncoder.json'         = $encoderRaw
        'service.json'               = $serviceJson
        $markerName                  = (Get-Marker -PresetId $preset.Id -PresetName $preset.Name -Fps $preset.Fps -Bitrate $bitrate)
    }

    $written = @()
    $skipped = @()
    foreach ($entry in $files.GetEnumerator()) {
        if (Sync-TextFile -Path (Join-Path $target $entry.Key) -Content $entry.Value) {
            $written += $entry.Key
        } else {
            $skipped += $entry.Key
        }
    }

    $tag = if (-not $existedBefore) { '[新增]' } elseif ($written.Count -gt 0) { '[已存在·已纠正]' } else { '[已存在·一致]' }
    Write-Host ''
    Write-Host "    $tag $($preset.Name)  —  $($preset.Summary)" -ForegroundColor Green
    Write-Ok "        $target"
    Write-Ok "        写/改：$(if ($written.Count) { $written -join ' ' } else { '（无）' })"
    if ($skipped.Count) { Write-Ok "        跳过（内容已一致）：$($skipped -join ' ')" }
    Write-Ok "        视频 1080p$($preset.Fps) · CBR $bitrate kbps · 关键帧 $($preset.Keyint)s · bf 0 · NVENC preset $($preset.EncoderPreset) · tune $($preset.Tune)"
    Write-Ok "        音频 $audioEncoder $audioKbps kbps · $audioRate Hz $audioChannel · 断流自动重连"

    $installed += [pscustomobject]@{
        Preset  = $preset
        Path    = $target
        Bitrate = $bitrate
        Files   = @($files.Keys)
        Changed = $written.Count
    }
}

# ---------------------------------------------------------------- 3/4 回读校验

Write-Step '3/4 回读校验（读磁盘上真正躺着的文件，不信内存里的）'

$verifyFailed = $false
foreach ($item in $installed) {
    $problems = @()

    $basicText = Get-Content -LiteralPath (Join-Path $item.Path 'basic.ini') -Raw
    $nameOnDisk = Get-IniValue -Text $basicText -Section 'General' -Key 'Name'
    if ($nameOnDisk -ne $item.Preset.Name) { $problems += "basic.ini 里 Name=$nameOnDisk，和目录名 $($item.Preset.Name) 不一致" }
    if ((Get-IniValue -Text $basicText -Section 'Output' -Key 'Mode') -ne 'Advanced') { $problems += 'basic.ini 的 Output Mode 不是 Advanced' }
    $fpsOnDisk = Get-IniValue -Text $basicText -Section 'Video' -Key 'FPSCommon'
    if ($fpsOnDisk -ne "$($item.Preset.Fps)") { $problems += "basic.ini 里 FPSCommon=$fpsOnDisk，应该是 $($item.Preset.Fps)" }
    foreach ($expected in @{ BaseCX = '1920'; BaseCY = '1080'; OutputCX = '1920'; OutputCY = '1080' }.GetEnumerator()) {
        $onDisk = Get-IniValue -Text $basicText -Section 'Video' -Key $expected.Key
        if ($onDisk -ne $expected.Value) {
            $problems += "basic.ini 里 $($expected.Key)=$onDisk，应该是 $($expected.Value)"
        }
    }
    if ((Get-IniValue -Text $basicText -Section 'Audio' -Key 'SampleRate') -ne '48000') { $problems += 'basic.ini 的采样率不是 48000' }

    $encOnDisk = (Get-Content -LiteralPath (Join-Path $item.Path 'streamEncoder.json') -Raw) | ConvertFrom-Json
    if ([int]$encOnDisk.bitrate -ne $item.Bitrate) { $problems += "streamEncoder.json 里 bitrate=$($encOnDisk.bitrate)，应该是 $($item.Bitrate)" }
    if ([int]$encOnDisk.bf -ne 0) { $problems += "streamEncoder.json 里 bf=$($encOnDisk.bf)，必须是 0" }
    if ($encOnDisk.rate_control -ne 'CBR') { $problems += "streamEncoder.json 里 rate_control=$($encOnDisk.rate_control)，应该是 CBR" }

    $svcOnDisk = (Get-Content -LiteralPath (Join-Path $item.Path 'service.json') -Raw) | ConvertFrom-Json
    $serverOnDisk = [string]$svcOnDisk.settings.server
    if ($svcOnDisk.type -ne 'whip_custom') { $problems += "service.json 的 type=$($svcOnDisk.type)，应该是 whip_custom" }
    if ($serverOnDisk -ne $whipUrl) { $problems += 'service.json 里的推流地址和本次要装的对不上（可能被 OBS 改写过，重跑一次即可）' }
    if ($serverOnDisk -match '__WHIP_URL__|changeme') { $problems += 'service.json 里的推流地址还是占位符/模板值' }

    if ($problems.Count -gt 0) {
        $verifyFailed = $true
        Write-Warn "$($item.Preset.Name)："
        foreach ($p in $problems) { Write-Warn "  - $p" }
    } else {
        Write-Good "$($item.Preset.Name)：$($item.Files.Count) 个文件都在，参数和推流地址一致；1080p$($item.Preset.Fps) $($item.Bitrate)kbps bf=0 CBR"
    }
}

# ---------------------------------------------------------------- 4/4 下一步

Write-Step '4/4 下一步'

Write-Host ''
Write-Host '  装到哪儿了（就这两个目录，别人的 profile 一律没碰）' -ForegroundColor Green
foreach ($item in $installed) {
    Write-Host "    $($item.Path)"
}
Write-Host ''
Write-Host '  OBS 里怎么切过去' -ForegroundColor Green
Write-Host '    打开 OBS → 上方菜单「配置文件」（英文界面 Profile）→ 选：'
Write-Host '      screen-share-3-4人    3-4 个人看，1080p20 @700 kbps（默认，出口 ≈3.3 Mbps）'
Write-Host '      screen-share-1-2人    1-2 个人看，1080p30 @1400 kbps（出口 ≈3.1 Mbps）'
Write-Host '    profile 列表是 OBS 启动时扫的，所以本次装完**第一次打开 OBS 就能看到**；'
Write-Host '    切换 profile 不影响 scene collection（画面来源沿用你现有那套）'
Write-Host ''
Write-Host '  然后' -ForegroundColor Green
Write-Host '    1. 加好画面来源（窗口采集 / 桌面音频），点「开始推流」'
Write-Host '    2. 核对实际生效的参数：'
Write-Host '         node scripts/check-obs.mjs'
Write-Host '       它读 OBS 日志，确认 B 帧真的是 0、码率/分辨率/Opus 都对得上 ——'
Write-Host '       OBS 界面上显示的值不一定等于真正生效的值，这一步别省'
Write-Host '    3. 要换回另一套：菜单里切 profile，OBS 会重新推流（不用重启）'
Write-Host ''
Write-Host '  想卸载：关掉 OBS，删掉上面那两个目录即可（用户自己的 profile 不受影响）' -ForegroundColor DarkGray
Write-Host ''

if ($verifyFailed) { Fail '回读校验没全过，见上面的 ! 行' 3 }
