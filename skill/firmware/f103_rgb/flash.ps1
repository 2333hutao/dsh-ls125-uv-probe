# flash.ps1 - flash the STM32F103 RGB light-source firmware with OpenOCD (ST-Link).
# ASCII only.

param(
    [string]$Elf
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Elf) { $Elf = Join-Path $root 'build\f103_rgb.elf' }
if (-not (Test-Path $Elf)) { throw "ELF not found: $Elf  (run build.ps1 first)" }

# Locate OpenOCD without hardcoding any machine path.
# Order: $env:OPENOCD -> PATH -> common install roots -> fail loudly.
function Find-OpenOcd {
    if ($env:OPENOCD) {
        if (Test-Path $env:OPENOCD) { return $env:OPENOCD }
        throw "OPENOCD is set but points at a missing file: $env:OPENOCD"
    }
    $onPath = Get-Command 'openocd.exe' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $cands = @(
        "$env:ProgramFiles\OpenOCD\bin\openocd.exe",
        "${env:ProgramFiles(x86)}\OpenOCD\bin\openocd.exe",
        'D:\tools\openocd\bin\openocd.exe',
        'C:\tools\openocd\bin\openocd.exe'
    ) | Where-Object { Test-Path $_ }
    if ($cands.Count -gt 0) { return $cands[0] }
    throw 'openocd.exe not found. Put it on PATH or set OPENOCD to its full path.'
}
$openocd = Find-OpenOcd
$openocdHome = Split-Path -Parent (Split-Path -Parent $openocd)
$scripts = Join-Path $openocdHome 'share\openocd\scripts'
if (-not (Test-Path $scripts)) {
    if ($env:OPENOCD_SCRIPTS -and (Test-Path $env:OPENOCD_SCRIPTS)) { $scripts = $env:OPENOCD_SCRIPTS }
    else { throw "OpenOCD scripts directory not found: $scripts  (set OPENOCD_SCRIPTS)" }
}

Write-Host "interface : stlink (interface/stlink.cfg)"
Write-Host "target    : target/stm32f1x.cfg"
Write-Host "elf       : $Elf"
Write-Host ''

$log  = Join-Path $env:TEMP 'openocd-f103.log'
$erro = Join-Path $env:TEMP 'openocd-f103.err'

# OpenOCD's Tcl parser treats backslash as an escape character INSIDE double
# quotes, so "C:\path\to\app.elf" silently becomes "C:pathtoapp.elf". Always hand it a
# forward-slash path.
$ElfTcl = ($Elf -replace '\\', '/')

$cmdArgs = @(
    '-s', $scripts,
    '-f', 'interface/stlink.cfg',
    '-f', 'target/stm32f1x.cfg',
    '-c', 'adapter speed 2000',
    '-c', "program `"$ElfTcl`" verify reset exit"
)

# NOTE: while $ErrorActionPreference is 'Stop', PS 5.1 turns the FIRST stderr
# line of a native command into a terminating NativeCommandError - the redirect
# files stay empty and the script dies mid-flash. Drop to 'Continue' for the
# native call and check $LASTEXITCODE explicitly.
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $openocd @cmdArgs > $log 2> $erro
$code = $LASTEXITCODE
$ErrorActionPreference = $savedEap

Get-Content $log, $erro -ErrorAction SilentlyContinue |
    Select-String -Pattern 'Error|error|Warn|warn|\*\*|Programming|Verified|flash|shutdown' |
    ForEach-Object { $_.Line }

if ($code -ne 0) {
    Write-Host ''
    Write-Host "openocd FAILED (exit $code) - full log: $log"
    Get-Content $log, $erro -ErrorAction SilentlyContinue | Select-Object -Last 40
    throw 'flash failed'
}

Write-Host ''
Write-Host "flash: OK (full log: $log)"
