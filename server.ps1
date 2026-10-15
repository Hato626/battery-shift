param([int]$Port = 8767, [switch]$NoBrowser, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
if (!$DataDir) { $DataDir = Join-Path $PSScriptRoot 'data' }
$null = New-Item -ItemType Directory -Force -Path $DataDir
$statePath = Join-Path $DataDir 'state.json'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$origin = "http://127.0.0.1:$Port"
$sessionToken = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
function Assert-Text($Value, [int]$Max, [switch]$AllowEmpty, [switch]$Id) {
  if ($Value -isnot [string] -or $Value.Length -gt $Max -or (!$AllowEmpty -and !$Value.Trim())) { throw 'Invalid text field' }
  if ($Id -and $Value -cnotmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid identifier' }
}
function Assert-Number($Value) {
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [bool] -or $Value -lt 0 -or $Value -gt 9007199254740991 -or [Math]::Floor($Value) -ne $Value) { throw 'Invalid nonnegative integer' }
}
function Assert-Date($Value) { if ($Value -isnot [string]) { throw 'Invalid date' }; $null = [DateTimeOffset]::Parse($Value) }
function Assert-State($State, [switch]$Core) {
  if (!$Core) {
    Assert-Number $State.schemaVersion; if ($State.schemaVersion -cne 1) { throw 'Unsupported state schema' }; Assert-Number $State.revision
    Assert-Date $State.createdAt; Assert-Date $State.updatedAt
    if ($State.history -isnot [array] -or $State.undo -isnot [array] -or $State.history.Count -gt 500 -or $State.undo.Count -gt 10) { throw 'Invalid history or undo stack' }
    foreach ($h in $State.history) { Assert-Text $h.id 100 -Id; Assert-Text $h.type 80; Assert-Text $h.summary 1000; Assert-Date $h.at }
    foreach ($u in $State.undo) { Assert-Text $u.summary 1000; Assert-State $u -Core }
  }
  if ($State.groups -isnot [array] -or $State.devices -isnot [array] -or $State.groups.Count -gt 2000 -or $State.devices.Count -gt 2000) { throw 'Invalid state collections' }
  $groups = @{}; $cells = @{}; $assigned = @{}; $slotIds = @{}; $deviceIds = @{}
  foreach ($g in $State.groups) {
    Assert-Text $g.id 100 -Id; Assert-Text $g.name 80; Assert-Text $g.location 120 -AllowEmpty; Assert-Text $g.notes 1000 -AllowEmpty
    Assert-Number $g.chargeCount; Assert-Number $g.useCount
    if ($g.format -cnotin @('AA','AAA','18650','9V','其他') -or $g.chemistry -cnotin @('NiMH','Li-ion','LiFePO4','其他')) { throw 'Invalid battery format' }
    if ($null -ne $g.lastUsedAt) { Assert-Date $g.lastUsedAt }; if ($null -ne $g.lastChargedAt) { Assert-Date $g.lastChargedAt }
    if (!$g.id -or !$g.name -or $groups.ContainsKey($g.id) -or $g.status -cnotin @('ready','in_use','empty','charging','retired')) { throw 'Invalid battery group' }
    if ($g.cells -isnot [array] -or $g.cells.Count -lt 1 -or $g.cells.Count -gt 24) { throw 'Invalid battery cells' }
    $groups[$g.id] = $g
    foreach ($c in $g.cells) { Assert-Text $c.id 100 -Id; Assert-Text $c.label 80; if ($cells.ContainsKey($c.id)) { throw 'Duplicate battery cell' }; $cells[$c.id] = $true }
  }
  foreach ($d in $State.devices) {
    Assert-Text $d.id 100 -Id; Assert-Text $d.name 80; Assert-Text $d.location 120 -AllowEmpty
    if (!$d.id -or !$d.name -or $deviceIds.ContainsKey($d.id) -or $d.slots -isnot [array] -or $d.slots.Count -lt 1 -or $d.slots.Count -gt 20) { throw 'Invalid device' }; $deviceIds[$d.id] = $true
    foreach ($slot in $d.slots) {
      Assert-Text $slot.id 100 -Id; Assert-Text $slot.name 80; Assert-Number $slot.count
      if ($slot.count -lt 1 -or $slot.count -gt 24 -or $slot.format -cnotin @('AA','AAA','18650','9V','其他') -or $slot.chemistry -cnotin @('不限','NiMH','Li-ion','LiFePO4','其他')) { throw 'Invalid slot specification' }
      if ($null -ne $slot.groupId) { Assert-Text $slot.groupId 100 -Id }
      if (!$slot.id -or $slotIds.ContainsKey($slot.id)) { throw 'Invalid slot' }; $slotIds[$slot.id] = $true
      if ($slot.groupId) {
        $g = $groups[$slot.groupId]
        if (!$g -or $assigned.ContainsKey($g.id) -or $g.status -ne 'in_use' -or $g.format -ne $slot.format -or $g.cells.Count -ne $slot.count -or ($slot.chemistry -ne '不限' -and $g.chemistry -ne $slot.chemistry)) { throw 'Conflicting battery assignment' }
        $assigned[$g.id] = $true
      }
    }
  }
  foreach ($g in $State.groups) { if (($g.status -eq 'in_use') -ne $assigned.ContainsKey($g.id)) { throw 'In-use battery must have exactly one slot' } }
}
try { $dataLock = [IO.File]::Open((Join-Path $DataDir 'server.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
catch { Write-Host 'This data directory is already in use by another Battery Shift instance.'; exit 1 }
if (!(Test-Path -LiteralPath $statePath)) {
  $now = [DateTime]::UtcNow.ToString('o')
  $initial = @{schemaVersion=1; revision=0; createdAt=$now; updatedAt=$now; groups=@(); devices=@(); history=@(); undo=@()} | ConvertTo-Json -Depth 50
  [IO.File]::WriteAllText($statePath, $initial, $utf8)
}
$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { Write-Host "Cannot use port $Port. Another instance may be running. Open $origin or choose another port."; exit 1 }
Write-Host "Battery Shift is running at $origin"
Write-Host "Data: $statePath"
Write-Host 'Keep this window open. Press Ctrl+C to stop.'
if (!$NoBrowser) { Start-Process $origin }
try {
  while ($true) {
    $client = $listener.AcceptTcpClient(); $client.ReceiveTimeout=10000; $client.SendTimeout=10000
    $stream=$client.GetStream(); $status=200; $mime='application/json; charset=utf-8'; $payload=$null
    try {
      $headerBytes = New-Object 'System.Collections.Generic.List[byte]'
      while ($headerBytes.Count -lt 16384) {
        $b=$stream.ReadByte(); if($b -lt 0){throw 'Incomplete request'}; $headerBytes.Add([byte]$b)
        $n=$headerBytes.Count
        if($n -ge 4 -and $headerBytes[$n-4] -eq 13 -and $headerBytes[$n-3] -eq 10 -and $headerBytes[$n-2] -eq 13 -and $headerBytes[$n-1] -eq 10){break}
      }
      if($headerBytes.Count -ge 16384){throw 'Request headers too large'}
      $lines=[Text.Encoding]::ASCII.GetString($headerBytes.ToArray()).Split(@("`r`n"),[StringSplitOptions]::None)
      $request=$lines[0].Split(' '); $method=$request[0]; $path=$request[1].Split('?')[0]; $headers=@{}
      foreach($line in $lines[1..($lines.Length-1)]) { $colon=$line.IndexOf(':'); if($colon -gt 0){$headers[$line.Substring(0,$colon).ToLowerInvariant()]=$line.Substring($colon+1).Trim()} }
      if($headers['host'] -ne "127.0.0.1:$Port"){ $status=403; throw 'Invalid Host' }
      if($headers['origin'] -and $headers['origin'] -ne $origin){$status=403; throw 'Cross-origin requests are not allowed'}
      if($method -eq 'GET' -and $path -eq '/api/session') {
        $payload=$utf8.GetBytes((@{token=$sessionToken}|ConvertTo-Json -Compress))
      } elseif($method -eq 'GET' -and $path -eq '/api/state') {
        $raw=[IO.File]::ReadAllText($statePath,$utf8); $parsed=ConvertFrom-Json $raw; Assert-State $parsed; $payload=$utf8.GetBytes($raw)
      } elseif($method -eq 'PUT' -and $path -eq '/api/state') {
        if($headers['x-battery-token'] -ne $sessionToken){$status=403;throw 'Session expired. Reload the page.'}
        if($headers['content-type'] -notlike 'application/json*'){ $status=415; throw 'JSON content type required' }
        [int]$length=0
        if(![int]::TryParse($headers['content-length'],[ref]$length) -or $length -lt 1 -or $length -gt 8388608){$status=413;throw 'Invalid request size'}
        $body=New-Object byte[] $length; $read=0
        while($read -lt $length){$part=$stream.Read($body,$read,$length-$read);if($part -eq 0){throw 'Incomplete request body'};$read+=$part}
        $inputData=ConvertFrom-Json ($utf8.GetString($body)); $candidate=$inputData.state; Assert-State $candidate
        $current=ConvertFrom-Json ([IO.File]::ReadAllText($statePath,$utf8)); Assert-State $current
        if($inputData.expectedRevision -ne $current.revision){$status=409;throw 'Revision conflict. Reload and try again.'}
        if($candidate.revision -ne ($current.revision+1)){$status=400;throw 'Invalid next revision'}
        $serialized=ConvertTo-Json -InputObject $candidate -Depth 100 -Compress
        $tempPath=Join-Path $DataDir ('state-'+[Guid]::NewGuid().ToString('N')+'.tmp')
        try {
          [IO.File]::WriteAllText($tempPath,$serialized,$utf8)
          [IO.File]::Replace($tempPath,$statePath,(Join-Path $DataDir 'state.previous.json'))
        } finally { if(Test-Path -LiteralPath $tempPath){Remove-Item -LiteralPath $tempPath -Force} }
        $payload=$utf8.GetBytes('{"ok":true}')
      } elseif($method -eq 'GET' -and $path -in @('/','/index.html','/app.js','/domain.js','/style.css')) {
        $filename=if($path -eq '/'){ 'index.html' }else{$path.TrimStart('/')}
        $mime=switch([IO.Path]::GetExtension($filename)){'.html'{'text/html; charset=utf-8'}'.css'{'text/css; charset=utf-8'}'.js'{'text/javascript; charset=utf-8'}}
        $payload=[IO.File]::ReadAllBytes((Join-Path (Join-Path $PSScriptRoot 'app') $filename))
      } else {$status=404;throw 'Not found'}
    } catch {
      if($status -eq 200){$status=400}
      $payload=$utf8.GetBytes((@{error=$_.Exception.Message} | ConvertTo-Json -Compress))
      $mime='application/json; charset=utf-8'
    }
    try {
      $reason=switch($status){200{'OK'}400{'Bad Request'}403{'Forbidden'}404{'Not Found'}409{'Conflict'}413{'Payload Too Large'}415{'Unsupported Media Type'}default{'Error'}}
      $response="HTTP/1.1 $status $reason`r`nContent-Type: $mime`r`nContent-Length: $($payload.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`r`n`r`n"
      $bytes=[Text.Encoding]::ASCII.GetBytes($response);$stream.Write($bytes,0,$bytes.Length);$stream.Write($payload,0,$payload.Length);$stream.Flush()
    } catch {} finally {$stream.Dispose();$client.Close()}
  }
} finally { $listener.Stop(); $dataLock.Dispose() }
