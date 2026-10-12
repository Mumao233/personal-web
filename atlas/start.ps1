param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8766,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$serverScript = Join-Path $PSScriptRoot 'server.py'
$pythonExe = $null
$pythonPrefix = @()

# Prefer a real Python launcher. Ignore Microsoft Store execution aliases.
foreach ($candidate in @('py.exe', 'python.exe', 'python3.exe')) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $command -or $command.Source -like '*\Microsoft\WindowsApps\*') {
        continue
    }
    $prefix = @()
    if ($candidate -eq 'py.exe') { $prefix = @('-3') }
    try {
        & $command.Source @prefix -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $pythonExe = $command.Source
            $pythonPrefix = $prefix
            break
        }
    } catch {
        # Try the next interpreter if this launcher cannot find Python.
    }
}

if (-not $pythonExe) {
    Write-Host 'Python 3.9 or newer is required. Install Python with Add Python to PATH enabled.' -ForegroundColor Red
    Write-Host 'Then double-click start.bat again. No extra Python packages are needed.'
    exit 1
}

$serverArguments = @($serverScript, '--port', $Port)
if (-not $NoBrowser) { $serverArguments += '--open' }
Write-Host 'Starting the offline Solar System Atlas...'
& $pythonExe @pythonPrefix @serverArguments
exit $LASTEXITCODE
