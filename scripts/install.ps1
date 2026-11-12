# Timon installer for Windows.
#
#   irm https://timon-ai.com/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://timon-ai.com/install.ps1))) -DryRun
#
# What it does, in order:
#   1. reads the signed release manifest of timon-ai.com (its keyId and its
#      expiry are checked; Windows PowerShell has no Ed25519, so the signature
#      itself is checked by Timon once installed, not here);
#   2. downloads the Windows installer of the stable channel (else beta) and
#      compares its size and SHA-256 with the manifest BEFORE running it;
#   3. runs the regular installer and waits for it. Not silently by default:
#      under /S the installer skips Node.js and Git, and does not pause a
#      running Timon before replacing it (desktop/build/installer.nsh).
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

  $manifestUrl = 'https://timon-ai.com/.well-known/timon-releases.json'
  # The keyId of orchestrator/src/plugins-bundled/updates/keyring.ts.
  $releaseKeyId = 'release-4253f18d5854243a'
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

Documentation: https://docs.timon-ai.com/installation/windows
'@
    return
  }

  # Test hooks: a test serves its own manifest and installer from files.
  # Read only when TIMON_INSTALL_TESTING=1.
  $testing = $env:TIMON_INSTALL_TESTING -eq '1'
  if ($testing) {
    if ($env:TIMON_INSTALL_MANIFEST_URL) { $manifestUrl = $env:TIMON_INSTALL_MANIFEST_URL }
    if ($env:TIMON_INSTALL_KEY_ID) { $releaseKeyId = $env:TIMON_INSTALL_KEY_ID }
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

  if (-not $testing -and [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-Install 'this installer is for Windows; on Linux and macOS run: curl -fsSL https://timon-ai.com/install.sh | sh'
  }
  # Windows on ARM runs the x64 build under emulation.
  $arch = $env:PROCESSOR_ARCHITECTURE
  if (-not $testing -and $arch -ne 'AMD64' -and $arch -ne 'ARM64') { Stop-Install "unsupported processor: $arch" }

  # Windows PowerShell 5.1 may still offer TLS 1.0 first.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  try {
    $envelope = (Get-Remote $manifestUrl $null) | ConvertFrom-Json
  } catch {
    Stop-Install "could not read the release manifest ($manifestUrl): $($_.Exception.Message)"
  }
  if ($envelope.keyId -ne $releaseKeyId) { Stop-Install "the release manifest is signed with an unknown key ($($envelope.keyId))" }
  try {
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$envelope.payload)) | ConvertFrom-Json
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
  Write-Output '  signature: checked by Timon once installed (Windows PowerShell cannot verify Ed25519)'
  if ($Silent) { Write-Output '  install:   silent installer (/S)' } else { Write-Output '  install:   the Timon installer window' }

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

    Write-Output 'Running the Timon installer...'
    # WaitForExit, not Start-Process -Wait: -Wait also waits for the
    # descendants, and the installer's last page may launch Timon itself.
    if ($Silent) {
      $process = Start-Process -FilePath $package -ArgumentList '/S' -PassThru
    } else {
      $process = Start-Process -FilePath $package -PassThru
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      Stop-Install "the installer ended with code $($process.ExitCode): Timon was not installed, or only partly. See $docsUrl"
    }
    Write-Output ''
    Write-Output "Timon $($entry.version) is installed. Open Timon from the Start menu to finish the setup."
    Write-Output 'The timon command is available in a new terminal.'
  } finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Install-Timon -DryRun:$DryRun -DownloadOnly:$DownloadOnly -Channel $Channel -Silent:$Silent -Help:$Help
