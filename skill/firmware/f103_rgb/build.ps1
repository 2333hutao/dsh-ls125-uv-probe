# build.ps1 - compile the STM32F103 RGB-LED light-source firmware.
# ASCII only (PS 5.1 parses .ps1 as ANSI/GBK -> non-ASCII breaks it).

param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $root 'build'

# Locate a bare-metal ARM toolchain without hardcoding any machine path.
# Order: $env:ARM_GCC_BIN -> PATH -> a few common install roots -> fail loudly.
function Find-GccBin {
    if ($env:ARM_GCC_BIN) {
        if (Test-Path (Join-Path $env:ARM_GCC_BIN 'arm-none-eabi-gcc.exe')) { return $env:ARM_GCC_BIN }
        throw "ARM_GCC_BIN is set but holds no arm-none-eabi-gcc.exe: $env:ARM_GCC_BIN"
    }
    $onPath = Get-Command 'arm-none-eabi-gcc.exe' -ErrorAction SilentlyContinue
    if ($onPath) { return (Split-Path -Parent $onPath.Source) }
    $roots = @(
        "$env:ProgramFiles\Arm GNU Toolchain arm-none-eabi",
        "${env:ProgramFiles(x86)}\Arm GNU Toolchain arm-none-eabi",
        "$env:LOCALAPPDATA\Arm GNU Toolchain arm-none-eabi",
        'C:\tools', 'D:\tools', "$env:ProgramFiles\xpack-arm-none-eabi-gcc"
    ) | Where-Object { $_ -and (Test-Path $_) }
    foreach ($r in $roots) {
        $hit = Get-ChildItem $r -Directory -Recurse -Depth 2 -Filter 'arm-none-eabi-gcc-*' -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) { return (Join-Path $hit.FullName 'bin') }
        $exe = Get-ChildItem $r -Recurse -Depth 3 -Filter 'arm-none-eabi-gcc.exe' -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($exe) { return $exe.DirectoryName }
    }
    throw 'arm-none-eabi-gcc.exe not found. Install the Arm GNU Toolchain (or an xpack arm-none-eabi-gcc build), put its bin on PATH, or point ARM_GCC_BIN at that bin directory.'
}
$binDir  = Find-GccBin
$gcc     = Join-Path $binDir 'arm-none-eabi-gcc.exe'
$objcopy = Join-Path $binDir 'arm-none-eabi-objcopy.exe'
$size    = Join-Path $binDir 'arm-none-eabi-size.exe'

if ($Clean -and (Test-Path $out)) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

$cflags = @(
    '-mcpu=cortex-m3',
    '-mthumb',
    '-O2',
    '-g3',
    '-ffreestanding',
    '-fno-common',
    '-Wall',
    '-Wextra',
    "-I$root"
)

$elf = Join-Path $out 'f103_rgb.elf'
$bin = Join-Path $out 'f103_rgb.bin'
$hex = Join-Path $out 'f103_rgb.hex'

$sources = @(
    (Join-Path $root 'startup.c'),
    (Join-Path $root 'main.c')
)

$gccArgs = @()
$gccArgs += $cflags
$gccArgs += @('-nostdlib', '-nostartfiles', "-T$(Join-Path $root 'link.ld')")
$gccArgs += @('-Wl,-Map,' + (Join-Path $out 'f103_rgb.map'))
$gccArgs += $sources
$gccArgs += @('-o', $elf)

Write-Host "gcc: $gcc"
& $gcc @gccArgs
if ($LASTEXITCODE -ne 0) { throw "compile failed (exit $LASTEXITCODE)" }

& $objcopy -O binary $elf $bin
if ($LASTEXITCODE -ne 0) { throw 'objcopy -O binary failed' }

& $objcopy -O ihex $elf $hex
if ($LASTEXITCODE -ne 0) { throw 'objcopy -O ihex failed' }

Write-Host ''
& $size $elf
Write-Host ''
Get-Item $elf, $bin, $hex | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

# sanity: the reset vector (word 1) must point into flash
$bytes = [System.IO.File]::ReadAllBytes($bin)
$sp = [BitConverter]::ToUInt32($bytes, 0)
$pc = [BitConverter]::ToUInt32($bytes, 4)
Write-Host ("vector[0] SP = 0x{0:X8}  (expect 0x2000xxxx)" -f $sp)
Write-Host ("vector[1] PC = 0x{0:X8}  (expect 0x0800xxxx)" -f $pc)
if (($sp -band 0x2FF00000) -ne 0x20000000) { throw 'initial stack pointer looks wrong' }
if (($sp -band 0x7) -ne 0) { throw 'initial stack pointer is not 8-byte aligned' }
if (($pc -band 0xFFF00000) -ne 0x08000000) { throw 'reset vector does not point into flash' }
if (($pc -band 0x1) -ne 0x1) { throw 'reset vector is missing the Thumb bit' }

Write-Host ''
Write-Host 'build: OK'
