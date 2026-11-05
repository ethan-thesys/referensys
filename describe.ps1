# SOP Builder helper: names the on-screen element at a point, using Windows UI Automation.
# Reads lines "<id> <x> <y> <useText>" (physical screen pixels) and writes one JSON line each:
# {"id":..,"app":..,"role":..,"label":..}. Every lookup is best-effort.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class SopDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][SopDpi]::SetProcessDPIAware()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
# Containers whose names are window or page titles, which aren't useful as step titles.
$skip = @('ControlType.Window','ControlType.Pane','ControlType.Document','ControlType.TitleBar','ControlType.Group','ControlType.Custom')
$apps = @{}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Trim().Split(' ')
  $out = [ordered]@{ id = $parts[0]; app = ''; role = ''; label = '' }
  try {
    $useText = $parts[3] -eq '1'
    $pt = New-Object System.Windows.Point([double]$parts[1], [double]$parts[2])
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    if ($el) {
      $procId = $el.Current.ProcessId
      if ($apps.ContainsKey($procId)) { $out.app = $apps[$procId] }
      else {
        try { $p = Get-Process -Id $procId; $n = if ($p.Description) { $p.Description } else { $p.ProcessName }; $apps[$procId] = $n; $out.app = $n } catch {}
      }
      for ($i = 0; $i -lt 3 -and $el; $i++) {
        $role = $el.Current.ControlType.ProgrammaticName
        if (-not $out.role) { $out.role = $role }
        if ($skip -contains $role) { break }
        if ($useText) {
          $name = "$($el.Current.Name)".Trim()
          if ($name -and $name.Length -le 80) { $out.role = $role; $out.label = $name; break }
        }
        $el = $walker.GetParent($el)
      }
    }
  } catch { $out.error = "$_" }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
