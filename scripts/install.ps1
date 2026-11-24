# Timon installer for Windows.
#
#   irm https://timon-ai.com/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://timon-ai.com/install.ps1))) -DryRun
#
# What it does, in order:
#   1. reads the signed installers' manifest of timon-ai.com and checks its
#      keyId, its P-256 signature (mandatory: Windows PowerShell has no
#      Ed25519, and a manifest it cannot check stops here) and its expiry;
#   2. downloads the Windows installer of the stable channel (else beta) and
#      compares its size and SHA-256 with the manifest BEFORE running it;
#   3. runs the regular installer and waits for it. Not silently by default:
#      under /S the installer skips Node.js and Git, and does not pause a
#      running Timon before replacing it (desktop/build/installer.nsh).
#      From a PowerShell run as administrator, File Explorer opens it, as a
#      double-click would: Timon installs for the desktop user, unelevated.
#
# The whole script is one function called on its last line: a download cut
# halfway runs nothing. Works on Windows PowerShell 5.1 and PowerShell 7.
#
# Source of truth: scripts/install.ps1 in the Timon repository, published as
# is at https://timon-ai.com/install.ps1 (docs/RELEASE-RC.md).

param(
  [switch]$DryRun,
  [switch]$DownloadOnly,
  [ValidateSet('', 'stable', 'beta')]
  [string]$Channel = '',
  [switch]$Silent,
  [switch]$Help
)

function Install-Timon {
  param(
    [switch]$DryRun,
    [switch]$DownloadOnly,
    [string]$Channel,
    [switch]$Silent,
    [switch]$Help
  )

  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest redraws its progress bar for every block: on Windows
  # PowerShell 5.1 a 150 MB download takes minutes instead of seconds.
  $ProgressPreference = 'SilentlyContinue'

  # The installers' manifest: the release manifest plus a P-256 signature
  # (scripts/release-manifest.mjs). Trust anchor: no fallback to the release
  # manifest the daemons read, which has no P-256 signature, so a network
  # attacker cannot downgrade the check by serving that file instead.
  $installManifestUrl = 'https://timon-ai.com/.well-known/timon-releases-install.json'
  # The keyId of orchestrator/src/plugins-bundled/updates/keyring.ts.
  $releaseKeyId = 'release-4253f18d5854243a'
  # The installers' P-256 key, its SPKI in base64 (docs/internal/scripts/
  # release-p256-keygen.mjs --pin writes both lines). Required.
  $releaseP256KeyId = 'release-701bbfb6d1c1eed1'
  $releaseP256PublicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyUUvXZE0kGYqgsXTRslQyKnF1Y5MK2wjSflgy5lGkUbEUzJK9zRP1Iv88aOPoObrkPVSyJWVW4fGJE2Q7N5C6w=='
  $signatureDomain = 'timon-releases-v1'
  $docsUrl = 'https://docs.timon-ai.com/installation/windows'
  $artifactKey = 'win-x64-nsis'

  if ($Help) {
    Write-Output @'
Timon installer for Windows.

  irm https://timon-ai.com/install.ps1 | iex
  & ([scriptblock]::Create((irm https://timon-ai.com/install.ps1))) [options]

Options:
  -DryRun         check the manifest and print what would be installed; change nothing
  -DownloadOnly   download and verify the installer, print its path, run nothing
  -Channel NAME   stable or beta (default: stable when published, else beta)
  -Silent         run the installer without its window (skips Node.js and Git: install them first)
  -Help           this help

Works from a normal PowerShell window and from one run as administrator:
there, File Explorer opens the installer, as a double-click would, so that
Timon installs for you and not as administrator.

Documentation: https://docs.timon-ai.com/installation/windows
'@
    return
  }

  # Test hooks: a test serves its own manifest and installer from files.
  # Read only when TIMON_INSTALL_TESTING=1.
  $testing = $env:TIMON_INSTALL_TESTING -eq '1'
  if ($testing) {
    if ($env:TIMON_INSTALL_MANIFEST_URL) { $installManifestUrl = $env:TIMON_INSTALL_MANIFEST_URL }
    if ($env:TIMON_INSTALL_KEY_ID) { $releaseKeyId = $env:TIMON_INSTALL_KEY_ID }
    if ($env:TIMON_INSTALL_P256_KEY) {
      $releaseP256PublicKey = $env:TIMON_INSTALL_P256_KEY
      $releaseP256KeyId = $env:TIMON_INSTALL_P256_KEY_ID
    }
  }

  # The Windows installer installs for the current user. Started from an
  # elevated PowerShell it failed with 0xC0000005 for a tester (TIM-0160),
  # while a double-click on the same file worked. Tests decide with
  # TIMON_INSTALL_ELEVATED: a CI runner is often an administrator.
  function Test-Elevated {
    if ($testing) { return $env:TIMON_INSTALL_ELEVATED -eq '1' }
    try {
      $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
      return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
      return $false
    }
  }

  # Whether File Explorer can open the installer unelevated for this
  # PowerShell: UAC on (with it off, Explorer runs as administrator too), and
  # an Explorer of this same account in this session. An administrator who
  # elevated with another account's password has no such Explorer: the
  # package sits in that account's temporary folder, out of the desktop
  # user's reach. Tests decide with TIMON_INSTALL_SHELL.
  function Test-DesktopShell {
    if ($testing) { return $env:TIMON_INSTALL_SHELL -ne '0' }
    try {
      $lua = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop).EnableLUA
      if ($lua -eq 0) { return $false }
      $session = (Get-Process -Id $PID).SessionId
      $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      # -IncludeUserName needs an elevated PowerShell, which this one is.
      $shells = Get-Process -Name explorer -IncludeUserName -ErrorAction SilentlyContinue |
        Where-Object { $_.SessionId -eq $session -and $_.UserName -eq $me }
      return [bool]$shells
    } catch {
      return $false
    }
  }

  # The installed Timon's version, from the uninstall entry the installer
  # writes: per user (HKCU) or for all users (HKLM). $null when none.
  function Get-InstalledVersion {
    foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall') {
      foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($entry -and [string]$entry.DisplayName -match '^Timon( |$)' -and $entry.DisplayVersion) { return [string]$entry.DisplayVersion }
      }
    }
    return $null
  }

  function Stop-Install([string]$message) {
    throw "timon-install: $message"
  }

  function Get-Remote([string]$url, [string]$outFile) {
    if ($testing -and -not $url.StartsWith('https://')) {
      $path = ([Uri]$url).LocalPath
      if ($outFile) { Copy-Item -LiteralPath $path -Destination $outFile; return }
      return [IO.File]::ReadAllText($path)
    }
    if (-not $url.StartsWith('https://')) { Stop-Install "refusing a non-HTTPS address: $url" }
    if ($outFile) {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $outFile
      return
    }
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
    return [string]$response.Content
  }

  # ConvertFrom-Json turns ISO dates into DateTime on PowerShell 7 only.
  function ConvertTo-Utc($value) {
    if ($value -is [DateTime]) { return $value.ToUniversalTime() }
    return [DateTimeOffset]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
  }

  # The manifest signs in DER, the encoding openssl reads; .NET wants r || s,
  # 32 bytes each. $null when it is not a DER ECDSA signature.
  function ConvertFrom-DerSignature([byte[]]$der) {
    if ($der.Length -lt 8 -or $der[0] -ne 0x30 -or $der[1] -ne ($der.Length - 2)) { return $null }
    $out = New-Object byte[] 64
    $at = 2
    foreach ($half in 0, 1) {
      if ($at + 2 -gt $der.Length -or $der[$at] -ne 0x02) { return $null }
      $length = [int]$der[$at + 1]
      $start = $at + 2
      if ($length -lt 1 -or $length -gt 33 -or $start + $length -gt $der.Length) { return $null }
      $skip = 0
      while ($skip -lt ($length - 1) -and $der[$start + $skip] -eq 0) { $skip++ }
      $size = $length - $skip
      if ($size -gt 32) { return $null }
      [Array]::Copy($der, $start + $skip, $out, ($half * 32) + 32 - $size, $size)
      $at = $start + $length
    }
    if ($at -ne $der.Length) { return $null }
    , $out
  }

  # ECDSA P-256 / SHA-256 with the classes of .NET Framework 4.7 and later
  # (and of PowerShell 7). $null when this .NET has none of them.
  function Test-P256Signature([byte[]]$spki, [byte[]]$der, [byte[]]$message) {
    if (-not ('System.Security.Cryptography.ECParameters' -as [type])) { return $null }
    # SubjectPublicKeyInfo of a P-256 key: a fixed 26-byte header, then the
    # uncompressed point 04 || X || Y.
    $header = [Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA=')
    if ($spki.Length -ne 91 -or $spki[26] -ne 4) { return $false }
    for ($i = 0; $i -lt 26; $i++) { if ($spki[$i] -ne $header[$i]) { return $false } }
    $signature = ConvertFrom-DerSignature $der
    if ($null -eq $signature) { return $false }
    $point = New-Object Security.Cryptography.ECPoint
    $point.X = [byte[]]$spki[27..58]
    $point.Y = [byte[]]$spki[59..90]
    $parameters = New-Object Security.Cryptography.ECParameters
    $parameters.Curve = [Security.Cryptography.ECCurve]::CreateFromValue('1.2.840.10045.3.1.7')
    $parameters.Q = $point
    $ecdsa = [Security.Cryptography.ECDsa]::Create($parameters)
    try {
      return $ecdsa.VerifyData($message, $signature, [Security.Cryptography.HashAlgorithmName]::SHA256)
    } finally {
      $ecdsa.Dispose()
    }
  }

  if (-not $testing -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-Install 'this installer is for Windows; on Linux and macOS run: curl -fsSL https://timon-ai.com/install.sh | sh'
  }
  # Windows on ARM runs the x64 build under emulation.
  $arch = $env:PROCESSOR_ARCHITECTURE
  if (-not $testing -and $arch -ne 'AMD64' -and $arch -ne 'ARM64') { Stop-Install "unsupported processor: $arch" }

  # /S cannot go through File Explorer, which passes no argument: a silent
  # install starts the installer from this PowerShell, elevated or not.
  $elevated = Test-Elevated
  $throughShell = $elevated -and -not $Silent -and -not $DownloadOnly -and (Test-DesktopShell)

  # Windows PowerShell 5.1 may still offer TLS 1.0 first.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  try {
    $envelope = Get-Remote $installManifestUrl $null | ConvertFrom-Json
  } catch {
    Stop-Install "could not read the release manifest ($installManifestUrl): $($_.Exception.Message)"
  }
  if ($envelope.keyId -ne $releaseKeyId) { Stop-Install "the release manifest is signed with an unknown key ($($envelope.keyId))" }
  if (-not $releaseP256PublicKey) { Stop-Install 'this installer pins no P-256 key: nothing was installed' }
  if (-not $envelope.p256 -or -not $envelope.p256.sig) {
    Stop-Install 'the release manifest has no P-256 signature: nothing was installed. Report it at https://timon-ai.com'
  }
  try {
    $payloadBytes = [Convert]::FromBase64String([string]$envelope.payload)
    $p256Signature = [Convert]::FromBase64String([string]$envelope.p256.sig)
  } catch {
    Stop-Install 'the release manifest is malformed'
  }

  if ($envelope.p256.keyId -ne $releaseP256KeyId) { Stop-Install "the release manifest is signed with an unknown P-256 key ($($envelope.p256.keyId))" }
  $domainBytes = [Text.Encoding]::ASCII.GetBytes($signatureDomain)
  $signed = New-Object byte[] ($domainBytes.Length + 1 + $payloadBytes.Length)
  [Array]::Copy($domainBytes, 0, $signed, 0, $domainBytes.Length)
  [Array]::Copy($payloadBytes, 0, $signed, $domainBytes.Length + 1, $payloadBytes.Length)
  $valid = Test-P256Signature ([Convert]::FromBase64String($releaseP256PublicKey)) $p256Signature $signed
  if ($null -eq $valid) {
    Stop-Install "this Windows cannot check the release manifest signature (it needs .NET Framework 4.7 or later, or PowerShell 7): nothing was installed. See $docsUrl"
  }
  if ($valid -ne $true) {
    Stop-Install 'the release manifest signature is INVALID: nothing was installed. Report it at https://timon-ai.com'
  }
  $signatureLine = 'verified'

  try {
    $payload = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
  } catch {
    Stop-Install 'the release manifest is malformed'
  }
  if ((ConvertTo-Utc $payload.expiresAt) -le [DateTime]::UtcNow) {
    Stop-Install "the release manifest has expired ($($payload.expiresAt)); try again later"
  }

  if ($Channel) {
    $entry = $payload.channels.$Channel
    if (-not $entry) { Stop-Install "no Timon release is published on the $Channel channel" }
  } elseif ($payload.channels.stable) {
    $Channel = 'stable'
    $entry = $payload.channels.stable
  } elseif ($payload.channels.beta) {
    $Channel = 'beta'
    $entry = $payload.channels.beta
  } else {
    Stop-Install 'no Timon release is published'
  }

  $artifact = $entry.artifacts.$artifactKey
  if (-not $artifact) { Stop-Install "no Windows package on the $Channel channel yet; see $docsUrl" }
  $name = [string]$artifact.name
  $url = [string]$artifact.url
  $sha = ([string]$artifact.sha256).ToLowerInvariant()
  if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { Stop-Install 'the release manifest names an invalid file' }
  if ($sha -notmatch '^[0-9a-f]{64}$') { Stop-Install 'the release manifest gives an invalid checksum' }
  if (-not ($artifact.size -is [int] -or $artifact.size -is [long]) -or $artifact.size -lt 1) {
    Stop-Install 'the release manifest gives an invalid size'
  }
  $size = [long]$artifact.size

  Write-Output "Timon $($entry.version) ($Channel channel) for Windows"
  Write-Output "  package:   $name ($([math]::Round($size / 1MB)) MB)"
  Write-Output "  from:      $url"
  Write-Output "  sha256:    $sha"
  Write-Output "  signature: $signatureLine"
  if ($Silent) {
    Write-Output '  install:   silent installer (/S)'
  } elseif ($throughShell) {
    Write-Output '  install:   the Timon installer window, opened by File Explorer (this PowerShell runs as administrator)'
  } else {
    Write-Output '  install:   the Timon installer window'
  }

  if ($DryRun) {
    Write-Output ''
    Write-Output 'Dry run: nothing was downloaded or installed.'
    return
  }

  # Over SSH the installer window opens where nobody sees it, and an
  # installer that finds Timon installed pauses its service until it exits.
  if (-not $DownloadOnly -and -not $Silent -and ($env:SSH_CONNECTION -or -not [Environment]::UserInteractive)) {
    Stop-Install 'there is no desktop session here (SSH or a service): the installer window would open where nobody can see it. Run this command in a desktop session, or add -Silent (without Node.js and Git, and with Timon closed)'
  }

  $work = Join-Path ([IO.Path]::GetTempPath()) ('timon-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  $package = Join-Path $work $name
  try {
    Write-Output ''
    Write-Output "Downloading $name..."
    try {
      Get-Remote $url $package
    } catch {
      Stop-Install "could not download $url`: $($_.Exception.Message)"
    }
    $gotSize = (Get-Item -LiteralPath $package).Length
    $gotSha = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($gotSize -ne $size -or $gotSha -ne $sha) {
      Remove-Item -LiteralPath $package -Force
      Stop-Install "the downloaded package does not match the manifest (size $gotSize, sha256 $gotSha): nothing was installed"
    }
    Write-Output 'Package verified.'

    if ($DownloadOnly) {
      Write-Output $package
      $work = $null
      return
    }

    # WaitForExit, not Start-Process -Wait: -Wait also waits for the
    # descendants, and the installer's last page may launch Timon itself.
    if ($throughShell) {
      Write-Output 'This PowerShell runs as administrator: File Explorer opens the Timon installer, so that Timon installs for you...'
      $since = Get-Date
      # explorer.exe hands the file to the Explorer already running on the
      # desktop, unelevated, and exits: the double-click that works.
      Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "`"$package`""
      # Found by name and start time, not by path: the temporary folder may
      # be an 8.3 path (C:\Users\JOHNDO~1) that the process list spells out.
      $process = $null
      $seen = $false
      for ($i = 0; $i -lt 120 -and -not $process; $i++) {
        Start-Sleep -Milliseconds 500
        $found = Get-CimInstance -ClassName Win32_Process -Filter "Name = '$name'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CreationDate -ge $since.AddSeconds(-2) } | Select-Object -First 1
        if ($found) {
          $seen = $true
          try {
            $process = Get-Process -Id $found.ProcessId -ErrorAction Stop
            # Holding a handle now keeps the exit code readable once it ends.
            $null = $process.Handle
          } catch {
            # Already gone: the installed version below tells the outcome.
            break
          }
        }
      }
      if (-not $seen) {
        $kept = $package
        $work = $null
        Stop-Install "File Explorer did not open the installer within a minute. The verified installer is kept at $kept`: open it from File Explorer, or run this command in a normal PowerShell window. See $docsUrl"
      }
      $exitCode = $null
      if ($process) {
        $process.WaitForExit()
        try { $exitCode = $process.ExitCode } catch { $exitCode = $null }
      }
      if ($null -eq $exitCode) {
        # The exit code could not be read: the uninstall entry tells.
        $installed = Get-InstalledVersion
        if ($installed -ne [string]$entry.version) {
          Stop-Install "the installer has closed and Timon $($entry.version) is not installed (installed: $(if ($installed) { $installed } else { 'none' })). See $docsUrl"
        }
        $exitCode = 0
      }
    } else {
      Write-Output 'Running the Timon installer...'
      if ($Silent) {
        $process = Start-Process -FilePath $package -ArgumentList '/S' -PassThru
      } else {
        $process = Start-Process -FilePath $package -PassThru
      }
      $process.WaitForExit()
      $exitCode = $process.ExitCode
    }
    # 0xC0000005 as a signed exit code: the failure TIM-0160 saw from an
    # administrator PowerShell, here when File Explorer could not be used.
    if ($exitCode -eq -1073741819) {
      $hint = if ($elevated) { ' It happens when the installer starts from an administrator session: run this command in a normal PowerShell window, or add -DownloadOnly and open the file it prints from File Explorer.' } else { '' }
      Stop-Install "the installer ended with code -1073741819 (0xC0000005): Timon was not installed.$hint See $docsUrl"
    }
    if ($exitCode -ne 0) {
      Stop-Install "the installer ended with code $exitCode`: Timon was not installed, or only partly. See $docsUrl"
    }
    Write-Output ''
    Write-Output "Timon $($entry.version) is installed. Open Timon from the Start menu to finish the setup."
    Write-Output 'The timon command is available in a new terminal.'
  } finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Install-Timon -DryRun:$DryRun -DownloadOnly:$DownloadOnly -Channel $Channel -Silent:$Silent -Help:$Help
