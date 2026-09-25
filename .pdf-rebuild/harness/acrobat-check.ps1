# Relecture T1 — vérification par Adobe Acrobat (IAC/COM, invisible). powershell -STA -File acro.ps1 <out.json> <pdf>...
param([string]$OutFile, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = "Continue"
$results = @()
$app = New-Object -ComObject AcroExch.App
foreach ($f in $Files) {
  $r = [ordered]@{ file = (Split-Path $f -Leaf) }
  $pd = New-Object -ComObject AcroExch.PDDoc
  try {
    $r.open = $pd.Open((Resolve-Path $f).Path)
    if ($r.open) {
      $r.pages = $pd.GetNumPages()
      $jso = $pd.GetJSObject()
      try { $r.dirty = $jso.dirty } catch { $r.dirty = "ERR " + $_.Exception.Message }
      try { $r.numFields = $jso.numFields } catch { $r.numFields = "ERR " + $_.Exception.Message }
      try { $r.producer = $jso.producer; $r.title = $jso.title; $r.info = ($jso.info | Out-String).Trim() } catch {}
      $sigs = @()
      try {
        for ($i = 0; $i -lt [int]$jso.numFields; $i++) {
          $name = $jso.getNthFieldName($i)
          $fld = $jso.getField($name)
          if ($fld.type -eq "signature") {
            $s = [ordered]@{ name = $name }
            try { $s.validate = $fld.signatureValidate() } catch { $s.validate = "ERR " + $_.Exception.Message }
            try { $info = $fld.signatureInfo(); $s.status = $info.status; $s.statusText = $info.statusText; $s.docValidity = $info.docValidity; $s.objValidity = $info.objValidity; $s.revision = $info.revision } catch { $s.info = "ERR " + $_.Exception.Message }
            $sigs += [pscustomobject]$s
          }
        }
      } catch { $r.sigErr = $_.Exception.Message }
      $r.sigs = $sigs
      $pd.Close() | Out-Null
    }
  } catch { $r.error = $_.Exception.Message }
  $results += [pscustomobject]$r
}
$app.CloseAllDocs() | Out-Null
$app.Exit() | Out-Null
$results | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $OutFile
