param(
  [string]$ProjectDir = "."
)

$ErrorActionPreference = "Stop"

function Write-Check($name, $ok, $detail = "") {
  if ($ok) {
    Write-Host "[OK]   $name $detail" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $name $detail" -ForegroundColor Red
  }
}

try {
  Set-Location $ProjectDir

  if (!(Test-Path ".env")) {
    throw "Fant ikke .env i prosjektmappen"
  }

  $vars = @{}
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $vars[$matches[1].Trim()] = $matches[2].Trim()
    }
  }

  $supabaseUrl = $vars["VITE_SUPABASE_URL"]
  $anonKey = $vars["VITE_SUPABASE_ANON_KEY"]

  if ([string]::IsNullOrWhiteSpace($supabaseUrl) -or [string]::IsNullOrWhiteSpace($anonKey)) {
    throw "Mangler VITE_SUPABASE_URL eller VITE_SUPABASE_ANON_KEY i .env"
  }

  $headers = @{
    apikey        = $anonKey
    Authorization = "Bearer $anonKey"
    "Content-Type" = "application/json"
  }

  $results = @()

  try {
    Invoke-RestMethod -Method Get -Uri "$supabaseUrl/functions/v1/price-update/active" -Headers $headers | Out-Null
    $results += @{ Name = "price-update/active"; Ok = $true; Detail = "" }
  } catch {
    $results += @{ Name = "price-update/active"; Ok = $false; Detail = $_.Exception.Message }
  }

  try {
    Invoke-RestMethod -Method Get -Uri "$supabaseUrl/functions/v1/availability-check/active" -Headers $headers | Out-Null
    $results += @{ Name = "availability-check/active"; Ok = $true; Detail = "" }
  } catch {
    $results += @{ Name = "availability-check/active"; Ok = $false; Detail = $_.Exception.Message }
  }

  try {
    $resp = Invoke-WebRequest -Method Get -Uri "$supabaseUrl/functions/v1/bokbasen/isbn/9788202693985" -Headers $headers
    $ok = $resp.StatusCode -eq 200 -or $resp.StatusCode -eq 422
    $results += @{ Name = "bokbasen/isbn"; Ok = $ok; Detail = "(status $($resp.StatusCode))" }
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__) {
      $code = $_.Exception.Response.StatusCode.value__
      $ok = $code -eq 422
      $results += @{ Name = "bokbasen/isbn"; Ok = $ok; Detail = "(status $code)" }
    } else {
      $results += @{ Name = "bokbasen/isbn"; Ok = $false; Detail = $_.Exception.Message }
    }
  }

  try {
    $body = @{ after = $null } | ConvertTo-Json
    $catalog = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/functions/v1/shopify/catalog" -Headers $headers -Body $body
    $count = @($catalog.products).Count
    $results += @{ Name = "shopify/catalog"; Ok = $true; Detail = "($count produkter)" }
  } catch {
    $detail = $_.Exception.Message
    if ($detail -match "500") {
      $detail = "$detail - sannsynligvis mangler Shopify credentials i user_settings eller env secrets"
    }
    $results += @{ Name = "shopify/catalog"; Ok = $false; Detail = $detail }
  }

  Write-Host "\n=== Smoke test resultater ===" -ForegroundColor Cyan
  foreach ($r in $results) {
    Write-Check $r.Name $r.Ok $r.Detail
  }

  $failed = @($results | Where-Object { -not $_.Ok }).Count
  if ($failed -gt 0) {
    Write-Host "\nNoen tester feilet. Kjør onboarding i appen og lagre Shopify/Bokbasen credentials per bruker, deretter kjør scriptet igjen." -ForegroundColor Yellow
    exit 1
  }

  Write-Host "\nAlle røyk-tester bestått." -ForegroundColor Green
  exit 0
}
catch {
  Write-Host "[FATAL] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
