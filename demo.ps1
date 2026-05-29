# Demo for fastify-idempotency.
#
# 1. In one terminal:   npm run example      (starts the server on :3000)
# 2. In a second terminal:   ./demo.ps1
#
# Sends the SAME Idempotency-Key twice and shows that the handler runs once,
# the response is replayed, and only one order is ever created.

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000'
$headers = @{ 'idempotency-key' = 'abc-123'; 'content-type' = 'application/json' }
$body = '{"item":"book"}'

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

# Make sure the server is up before we start.
try {
  Invoke-WebRequest "$base/orders" -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
  Write-Host "Server not reachable on $base." -ForegroundColor Red
  Write-Host "Start it first in another terminal with:  npm run example" -ForegroundColor Yellow
  exit 1
}

Step 'Request 1 — same key "abc-123" (handler RUNS, response cached)'
$r1 = Invoke-WebRequest "$base/orders" -Method Post -Headers $headers -Body $body -UseBasicParsing
Write-Host ("status   : {0}" -f $r1.StatusCode)
Write-Host ("replayed : {0}" -f ($r1.Headers['idempotent-replayed'] ?? '(none — this is the original)'))
Write-Host ("body     : {0}" -f $r1.Content)

Step 'Request 2 — SAME key "abc-123" (handler SKIPPED, response REPLAYED)'
$r2 = Invoke-WebRequest "$base/orders" -Method Post -Headers $headers -Body $body -UseBasicParsing
Write-Host ("status   : {0}" -f $r2.StatusCode)
Write-Host ("replayed : {0}" -f $r2.Headers['idempotent-replayed']) -ForegroundColor Green
Write-Host ("body     : {0}   <- same id as request 1" -f $r2.Content) -ForegroundColor Green

Step 'All orders on the server (proof: only ONE was created)'
$all = Invoke-RestMethod "$base/orders"
$all | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("Total orders created: {0}" -f @($all).Count) -ForegroundColor Green

Step 'Bonus — same key, DIFFERENT payload (rejected with 422)'
try {
  Invoke-WebRequest "$base/orders" -Method Post -Headers $headers -Body '{"item":"pen"}' -UseBasicParsing | Out-Null
} catch {
  Write-Host ("status   : {0} (Idempotency-Key reused with a different body)" -f $_.Exception.Response.StatusCode.value__) -ForegroundColor Green
}
