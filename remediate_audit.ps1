$ErrorActionPreference = "Stop"

# --- 0. PRE-FLIGHT CHECKS ---
Write-Host ">>> [AUDIT] Starting Pre-flight Checks..." -ForegroundColor Cyan

# Check Clean Git
$gitStatus = git status --porcelain
if ($gitStatus) {
    Write-Error "OSTILE AUDIT ABORT: Git working tree is dirty. Commit or stash changes before running Critical Gate."
}

# Capture Environment
$commitHash = git rev-parse HEAD
$nodeVersion = node -v
$npmVersion = npm -v
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$cwd = Get-Location

Write-Host ">>> [AUDIT] Environment Captured:"
Write-Host "    Commit: $commitHash"
Write-Host "    Node:   $nodeVersion"
Write-Host "    Time:   $timestamp"

# --- 1. SETUP EVIDENCE DIR ---
$evidenceBase = "$cwd\bench\sensitive\critical\evidence"
$runDirName = "${commitHash}_${timestamp}"
$runDir = "$evidenceBase\$runDirName"
$logsDir = "$runDir\logs"
if (!(Test-Path $evidenceBase)) { New-Item -ItemType Directory -Path $evidenceBase | Out-Null }
New-Item -ItemType Directory -Path $runDir | Out-Null
New-Item -ItemType Directory -Path $logsDir | Out-Null

Write-Host ">>> [AUDIT] Evidence Directory Created: $runDir"

# --- 2. EXECUTION ---
$runners = @(
    "enforcement_runner.ts",
    "integrity_runner.ts",
    "integrity_scope_verifier.ts",
    "crash_runner.ts",
    "concurrency_runner.ts",
    "resource_runner.ts",
    "fuzz_runner.ts",
    "error_discipline.ts"
)

# Master Seed
$masterSeed = 8675309 # Deterministic Master Seed for "Run A"
$env:MASTER_SEED = $masterSeed
$env:GIT_COMMIT = $commitHash

$results = @()
$allPass = $true
$seeds = @{}

Write-Host ">>> [AUDIT] Starting Execution Phase (Master Seed: $masterSeed)..." -ForegroundColor Cyan

foreach ($script in $runners) {
    $scriptName = $script -replace "\.ts$", ""
    $logFile = "$logsDir\$scriptName.log"
    
    Write-Host "    Running $scriptName..." -NoNewline
    
    $startTime = Get-Date
    
    # Run via npx tsx, redirect output. 
    # PowerShell redirection handles stdout/stderr to file
    try {
        # We invoke cmd /c to handle redirection cleanly natively if PS causes distinct file locking issues or encoding issues
        # But PS `> file 2>&1` is usually fine.
        $cmd = "npx tsx bench/sensitive/critical/$script"
        
        # Invoke and capture output to file
        Invoke-Expression "$cmd > ""$logFile"" 2>&1"
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host " [PASS]" -ForegroundColor Green
            $status = "PASS"
        }
        else {
            Write-Host " [FAIL]" -ForegroundColor Red
            $status = "FAIL"
            $allPass = $false
        }
        
        $duration = (Get-Date) - $startTime
        
        # Parse log for AUDIT_META to extract seed if present
        $logContent = Get-Content $logFile -ErrorAction SilentlyContinue
        $metaLine = $logContent | Where-Object { $_ -match "AUDIT_META" }
        if ($metaLine -and $metaLine -match "seed=(\d+)") {
            $seeds[$scriptName] = $matches[1]
        }
        
        $results += [PSCustomObject]@{
            Runner   = $scriptName
            Status   = $status
            Duration = $duration.TotalMilliseconds
            Log      = "$logsDir\$scriptName.log"
        }
        
    }
    catch {
        Write-Host " [CRASH]" -ForegroundColor Red
        $allPass = $false
        $results += [PSCustomObject]@{
            Runner   = $scriptName
            Status   = "CRASH"
            Duration = 0
            Log      = "$logsDir\$scriptName.log"
        }
    }
}

# --- 3. ARTIFACT GENERATION ---

# config.json
$config = @{
    hard_limits = @{
        MAX_BLOCK_ITEMS = 10000
        MAX_RLE_RUN     = 2000
    }
    protocol    = "v1.2"
    eos_policy  = "REQUIRED"
    environment = @{
        node   = $nodeVersion
        commit = $commitHash
    }
}
$config | ConvertTo-Json | Set-Content "$runDir\config.json"

# seeds.json
$seeds | ConvertTo-Json | Set-Content "$runDir\seeds.json"

# REPORT
$reportContent = @"
# Critical Assurance Audit Report

**Date:** $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
**Commit:** $commitHash
**GICS Version:** 1.2 (Critical)
**Master Seed:** $masterSeed

## Executive Summary
The Critical Assurance Gate has executed $($runners.Count) vectors.
Result: **$(if($allPass){"PASS"}else{"FAIL"})**

## Runner Results
| Vector | Runner | Status | Duration (ms) | Log |
|---|---|---|---|---|
"@

foreach ($res in $results) {
    $reportContent += "| $($res.Runner.Split('_')[0].ToUpper()) | $($res.Runner) | $($res.Status) | $([math]::Round($res.Duration)) | [log](logs/$($res.Runner).log) |`n"
}

$reportContent += @"

## Configuration Snaphot
- **Hard Limits:** MAX_BLOCK_ITEMS=10000, MAX_RLE_RUN=2000
- **Integrity Scope:** Structural Validity Checked.
- **Protocol:** v1.2 + EOS Required.

## Evidence checksums
See \`checksums.sha256\` in the zip bundle.
"@

Set-Content "$runDir\CRITICAL_AUDIT_REPORT.md" $reportContent

# Checksums
Write-Host ">>> [AUDIT] Computing SHA256 Checksums..."
$files = Get-ChildItem -Path $runDir -Recurse | Where-Object { ! $_.PSIsContainer }
$checksums = @()
foreach ($f in $files) {
    $hash = Get-FileHash $f.FullName -Algorithm SHA256
    $relPath = $f.FullName.Substring($runDir.Length + 1).Replace("\", "/")
    $checksums += "$($hash.Hash)  $relPath"
}
$checksums | Set-Content "$runDir\checksums.sha256"

# Zip
$zipName = "gics_v1.2_critical_evidence_${commitHash}_${timestamp}.zip"
$zipPath = "$evidenceBase\$zipName"
Compress-Archive -Path "$runDir\*" -DestinationPath $zipPath -Force

# Zip Hash
$zipHash = Get-FileHash $zipPath -Algorithm SHA256
$reportContent += "`n## Bundle Checksum`n`n\`$($zipHash.Hash)\` ($zipName)"
Set-Content "$runDir\CRITICAL_AUDIT_REPORT.md" $reportContent

# Update zip with new report? Simpler to just print it. The requirement says "Include the ZIP checksum in the report".
# To do that, I'd need to re-zip. 
# Compromise: I will append it to the Report inside the directory, but the Zip won't contain the modified report unless I re-zip.
# I will re-zip.
Compress-Archive -Path "$runDir\*" -DestinationPath $zipPath -Update

Write-Host "`n>>> [AUDIT] VERDICT: $(if($allPass){"PASS"}else{"FAIL"})" -ForegroundColor $(if ($allPass) { "Green" }else { "Red" })
Write-Host "    Evidence Bundle: $zipPath"
Write-Host "    Bundle SHA256:   $($zipHash.Hash)"

if (!$allPass) { exit 1 }
exit 0
