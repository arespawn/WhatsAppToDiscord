#!/usr/bin/env pwsh
[CmdletBinding()]
param(
	[Parameter()]
	[string]$Dir = "WhatsAppToDiscord",

	[Parameter()]
	[string]$Ref = "",

	[Parameter()]
	[string]$Repo = "https://github.com/arespawn/WhatsAppToDiscord.git",

	[Parameter()]
	[switch]$Start
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeMajorRequired = 24
$NodeMinorRequired = 15
$NodeMajorNextSupported = 26
$NodeRequiredRange = "^24.15.0 || >=26.0.0"
$RepoHint = "arespawn/WhatsAppToDiscord"

function Write-Log {
	param([string]$Message)
	Write-Host "[wa2dc-install] $Message"
}

function Write-WarnLog {
	param([string]$Message)
	Write-Warning "[wa2dc-install] $Message"
}

function Fail {
	param([string]$Message)
	throw "[wa2dc-install] ERROR: $Message"
}

function Test-Command {
	param([Parameter(Mandatory = $true)][string]$Name)
	return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Checked {
	param(
		[Parameter(Mandatory = $true)][string]$FilePath,
		[Parameter()][string[]]$Arguments = @(),
		[Parameter(Mandatory = $true)][string]$Context
	)

	& $FilePath @Arguments
	$code = $LASTEXITCODE
	if ($code -ne 0) {
		Fail "$Context failed with exit code $code."
	}
}

function Test-NodeVersionSupported {
	$version = node -p "process.versions.node" 2>$null
	if (-not $version) {
		return $false
	}
	$parts = $version.Split(".")
	$major = [int]$parts[0]
	$minor = [int]$parts[1]
	return (($major -eq $NodeMajorRequired -and $minor -ge $NodeMinorRequired) -or $major -ge $NodeMajorNextSupported)
}

function Install-WithWinget {
	param([Parameter(Mandatory = $true)][string]$PackageId)
	if (-not (Test-Command "winget")) {
		return $false
	}

	Write-Log "Installing '$PackageId' via winget"
	& winget install --id $PackageId --exact --silent --accept-source-agreements --accept-package-agreements
	if ($LASTEXITCODE -ne 0) {
		return $false
	}
	return $true
}

function Install-Node {
	if (Test-Command "node") {
		if (Test-NodeVersionSupported) {
			Write-Log ("Node.js {0} already satisfies {1}" -f (node -v), $NodeRequiredRange)
			return
		}
		Write-WarnLog ("Found Node.js {0}, installing a version that satisfies {1}" -f (node -v), $NodeRequiredRange)
	}
	else {
		Write-Log "Node.js not found, installing a version that satisfies $NodeRequiredRange"
	}

	$installed = $false
	if (Install-WithWinget -PackageId "OpenJS.NodeJS.LTS") {
		$installed = $true
	}
	elseif (Test-Command "choco") {
		Write-Log "Installing nodejs-lts via Chocolatey"
		Invoke-Checked -FilePath "choco" -Arguments @("install", "-y", "nodejs-lts") -Context "Chocolatey nodejs-lts install"
		$installed = $true
	}
	else {
		Fail "Node.js install requires winget or choco. Install Node.js $NodeRequiredRange manually and re-run."
	}

	if (-not $installed) {
		Fail "Failed to install Node.js"
	}

	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
		[System.Environment]::GetEnvironmentVariable("Path", "User")

	if (-not (Test-Command "node")) {
		Fail "Node.js installation completed but 'node' is not available in PATH. Open a new terminal and re-run."
	}

	if (-not (Test-NodeVersionSupported)) {
		Fail ("Installed Node.js {0}, expected {1}" -f (node -v), $NodeRequiredRange)
	}

	Write-Log ("Using Node.js {0}" -f (node -v))
}

function Install-Git {
	if (Test-Command "git") {
		return
	}

	Write-Log "git not found, installing"
	if (Install-WithWinget -PackageId "Git.Git") {
	}
	elseif (Test-Command "choco") {
		Invoke-Checked -FilePath "choco" -Arguments @("install", "-y", "git") -Context "Chocolatey git install"
	}
	else {
		Fail "git install requires winget or choco. Install git manually and re-run."
	}

	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
		[System.Environment]::GetEnvironmentVariable("Path", "User")

	if (-not (Test-Command "git")) {
		Fail "git installation completed but 'git' is not available in PATH. Open a new terminal and re-run."
	}
}

function Ensure-Npm {
	if (-not (Test-Command "npm")) {
		Fail "npm is missing. Ensure Node.js $NodeRequiredRange is installed correctly."
	}
}

function Clone-OrUpdateRepo {
	if (Test-Path (Join-Path $Dir ".git")) {
		$origin = (& git -C $Dir config --get remote.origin.url 2>$null).Trim()
		if (-not $origin) {
			Fail "Could not determine git origin for '$Dir'."
		}

		if (($origin -notlike "*$RepoHint*") -and ($origin -ne $Repo)) {
			Fail "Directory '$Dir' is a git repo, but not '$RepoHint'."
		}

		Write-Log "Repository exists, fetching updates in '$Dir'"
		Invoke-Checked -FilePath "git" -Arguments @("-C", $Dir, "fetch", "--tags", "origin") -Context "git fetch"
	}
	else {
		if (Test-Path $Dir) {
			$items = Get-ChildItem -Force -Path $Dir
			if ($items.Count -gt 0) {
				Fail "Directory '$Dir' exists and is not an empty WA2DC git repo."
			}
		}

		Write-Log "Cloning repository into '$Dir'"
		Invoke-Checked -FilePath "git" -Arguments @("clone", "--origin", "origin", $Repo, $Dir) -Context "git clone"
	}

	if ($Ref) {
		Write-Log "Checking out requested ref '$Ref'"
		Invoke-Checked -FilePath "git" -Arguments @("-C", $Dir, "fetch", "origin", $Ref) -Context "git fetch ref"
		Invoke-Checked -FilePath "git" -Arguments @("-C", $Dir, "checkout", "--detach", "FETCH_HEAD") -Context "git checkout"
	}
	else {
		$branch = (& git -C $Dir rev-parse --abbrev-ref HEAD).Trim()
		if ($LASTEXITCODE -ne 0) {
			Fail "Could not determine current git branch for '$Dir'."
		}

		if ($branch -eq "HEAD") {
			Write-WarnLog "Detached HEAD detected; keeping current checkout (use -Ref to set a revision)."
		}
		else {
			Write-Log "Updating current branch '$branch'"
			& git -C $Dir pull --ff-only origin $branch
			if ($LASTEXITCODE -ne 0) {
				Write-WarnLog "Could not fast-forward '$branch'. Keeping current checkout in '$Dir'."
			}
		}
	}
}

function Install-Dependencies {
	Write-Log "Installing dependencies with npm ci"
	Push-Location $Dir
	try {
		Invoke-Checked -FilePath "npm" -Arguments @("ci") -Context "npm ci"
	}
	finally {
		Pop-Location
	}
}

function Start-AppIfRequested {
	if (-not $Start) {
		return
	}

	Write-Log "Starting WA2DC (npm start)"
	Set-Location $Dir
	Invoke-Checked -FilePath "npm" -Arguments @("start") -Context "npm start"
}

function Main {
	Install-Node
	Install-Git
	Ensure-Npm
	Clone-OrUpdateRepo
	Install-Dependencies

	Write-Log "Install/update completed successfully."
	Write-Log "Next step: cd $Dir ; npm start"
	Start-AppIfRequested
}

Main
