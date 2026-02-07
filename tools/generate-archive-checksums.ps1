# Generate SHA256 checksums for GICS-ARCHIVE
# Run this script FROM the GICS-ARCHIVE root directory:
#   cd C:\Users\shilo\Documents\Github\GICS-ARCHIVE
#   .\path\to\generate-archive-checksums.ps1
# Or copy this script to GICS-ARCHIVE and run: .\generate-archive-checksums.ps1

$ErrorActionPreference = "Stop"
$root = Get-Location

# Ensure checksums directory exists
if (-not (Test-Path "checksums")) {
    New-Item -ItemType Directory -Name "checksums" | Out-Null
}

Write-Host "Generating SHA256 checksums for all files in GICS-ARCHIVE..." -ForegroundColor Cyan

# Get all files (excluding .git and the checksums file itself)
$files = Get-ChildItem -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/]\.git[\\/]' -and
    $_.FullName -notmatch '[\\/]checksums[\\/]SHA256SUMS\.txt$'
}

$checksums = @()
$count = 0

foreach ($file in $files) {
    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    $relativePath = $file.FullName.Replace($root.Path + "\", "").Replace("\", "/")
    $checksums += "$hash  $relativePath"
    $count++
    Write-Progress -Activity "Hashing files" -Status $relativePath -PercentComplete (($count / $files.Count) * 100)
}

# Sort for consistent output
$checksums = $checksums | Sort-Object

# Write to file
$checksums | Out-File -FilePath "checksums\SHA256SUMS.txt" -Encoding UTF8

Write-Host "`n✅ Generated $count checksums → checksums\SHA256SUMS.txt" -ForegroundColor Green
Write-Host "Run: git add checksums && git commit -m 'archive: add checksums'" -ForegroundColor Yellow
