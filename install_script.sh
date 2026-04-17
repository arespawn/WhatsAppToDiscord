#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

REPO_URL="https://github.com/arespawn/WhatsAppToDiscord.git"
REPO_HINT="arespawn/WhatsAppToDiscord"
NODE_MAJOR_REQUIRED=24
INSTALL_DIR="WhatsAppToDiscord"
REPO_REF=""
START_AFTER_INSTALL=0
OS_NAME=""

log() {
	printf '[wa2dc-install] %s\n' "$*"
}

warn() {
	printf '[wa2dc-install] WARN: %s\n' "$*" >&2
}

die() {
	printf '[wa2dc-install] ERROR: %s\n' "$*" >&2
	exit 1
}

on_error() {
	local line="$1"
	die "Installer failed at line ${line}."
}

trap 'on_error "$LINENO"' ERR

usage() {
	cat <<'EOF'
WA2DC installer (Linux/macOS)

Usage:
  ./install_script.sh [options]

Options:
  --dir <path>      Install/update repository at <path> (default: WhatsAppToDiscord)
  --ref <git-ref>   Checkout a branch/tag/commit after clone/fetch
  --repo <url>      Override repository URL (default: official WA2DC repo)
  --start           Start the app at the end (runs: npm start)
  --help            Show this help

This script:
  1) Ensures Node.js >=24 is installed
  2) Clones or updates the WA2DC repository
  3) Installs dependencies with npm ci

Notes:
  - Linux bootstrap is implemented for Debian/Ubuntu (APT + signed NodeSource repo).
  - macOS bootstrap uses Homebrew.
  - For native Windows, use install_script.ps1.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--dir)
		[[ $# -ge 2 ]] || die "--dir requires a value"
		INSTALL_DIR="$2"
		shift 2
		;;
	--ref)
		[[ $# -ge 2 ]] || die "--ref requires a value"
		REPO_REF="$2"
		shift 2
		;;
	--repo)
		[[ $# -ge 2 ]] || die "--repo requires a value"
		REPO_URL="$2"
		shift 2
		;;
	--start)
		START_AFTER_INSTALL=1
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		die "Unknown option: $1 (use --help)"
		;;
	esac
done

detect_os() {
	case "$(uname -s)" in
	Linux)
		OS_NAME="linux"
		;;
	Darwin)
		OS_NAME="macos"
		;;
	*)
		die "Unsupported OS: $(uname -s). Use install_script.ps1 on Windows."
		;;
	esac
}

run_as_root() {
	if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
		"$@"
	else
		command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root"
		sudo "$@"
	fi
}

require_cmd() {
	local cmd="$1"
	command -v "$cmd" >/dev/null 2>&1 || die "Missing required command: ${cmd}"
}

brew_bin() {
	if command -v brew >/dev/null 2>&1; then
		command -v brew
	elif [[ -x /opt/homebrew/bin/brew ]]; then
		printf '/opt/homebrew/bin/brew\n'
	elif [[ -x /usr/local/bin/brew ]]; then
		printf '/usr/local/bin/brew\n'
	else
		return 1
	fi
}

linux_is_debian_family() {
	[[ -r /etc/os-release ]] || return 1
	# shellcheck disable=SC1091
	source /etc/os-release
	[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" || "${ID_LIKE:-}" == *debian* ]]
}

install_git_linux() {
	linux_is_debian_family || die "git is required. Auto-install supports Debian/Ubuntu only."
	log "Installing missing dependency: git"
	run_as_root apt-get update
	run_as_root apt-get install -y git
}

install_git_macos() {
	local brew_path
	brew_path="$(brew_bin)" || die "git is required. Install Homebrew first: https://brew.sh/"
	log "Installing missing dependency: git (Homebrew)"
	"${brew_path}" install git
}

ensure_git() {
	if command -v git >/dev/null 2>&1; then
		return
	fi

	case "${OS_NAME}" in
	linux) install_git_linux ;;
	macos) install_git_macos ;;
	*) die "git is required but not installed" ;;
	esac
	require_cmd git
}

node_major_version() {
	node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null
}

install_node_debian() {
	linux_is_debian_family || die "Linux auto-install supports Debian/Ubuntu only"

	log "Installing Node.js ${NODE_MAJOR_REQUIRED}.x from signed NodeSource APT repo"
	run_as_root apt-get update
	run_as_root apt-get install -y ca-certificates curl gnupg git
	run_as_root install -d -m 0755 /etc/apt/keyrings

	local key_tmp
	key_tmp="$(mktemp)"
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "${key_tmp}"
	run_as_root gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg "${key_tmp}"
	rm -f "${key_tmp}"
	run_as_root chmod 0644 /etc/apt/keyrings/nodesource.gpg

	printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "${NODE_MAJOR_REQUIRED}" |
		run_as_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
	run_as_root chmod 0644 /etc/apt/sources.list.d/nodesource.list

	run_as_root apt-get update
	run_as_root apt-get install -y nodejs
}

install_node_macos() {
	local brew_path
	local node_prefix

	brew_path="$(brew_bin)" || die "Install Homebrew first (https://brew.sh/) or install Node.js >=${NODE_MAJOR_REQUIRED} manually."
	log "Installing Node.js ${NODE_MAJOR_REQUIRED} with Homebrew"
	"${brew_path}" install "node@${NODE_MAJOR_REQUIRED}"

	node_prefix="$("${brew_path}" --prefix "node@${NODE_MAJOR_REQUIRED}")"
	export PATH="${node_prefix}/bin:${PATH}"
}

ensure_node() {
	if command -v node >/dev/null 2>&1; then
		local major
		major="$(node_major_version)"
		if (( major >= NODE_MAJOR_REQUIRED )); then
			log "Node.js $(node -v) already satisfies >=${NODE_MAJOR_REQUIRED}"
			return
		fi
		warn "Found Node.js $(node -v), upgrading to >=${NODE_MAJOR_REQUIRED}"
	else
		log "Node.js not found, installing >=${NODE_MAJOR_REQUIRED}"
	fi

	case "${OS_NAME}" in
	linux) install_node_debian ;;
	macos) install_node_macos ;;
	*) die "Unsupported OS for Node.js bootstrap" ;;
	esac

	command -v node >/dev/null 2>&1 || die "Node.js installation did not provide 'node'"
	local major
	major="$(node_major_version)"
	(( major >= NODE_MAJOR_REQUIRED )) || die "Installed Node.js $(node -v), expected >=${NODE_MAJOR_REQUIRED}"
	log "Using Node.js $(node -v)"
}

clone_or_update_repo() {
	if [[ -d "${INSTALL_DIR}/.git" ]]; then
		local origin
		origin="$(git -C "${INSTALL_DIR}" config --get remote.origin.url || true)"
		[[ "${origin}" == *"${REPO_HINT}"* || "${origin}" == "${REPO_URL}" ]] || {
			die "Directory '${INSTALL_DIR}' is a git repo, but not '${REPO_HINT}'"
		}

		log "Repository exists, fetching updates in '${INSTALL_DIR}'"
		git -C "${INSTALL_DIR}" fetch --tags origin
	else
		if [[ -e "${INSTALL_DIR}" ]]; then
			if [[ -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ]]; then
				die "Directory '${INSTALL_DIR}' exists and is not an empty WA2DC git repo"
			fi
		fi

		log "Cloning repository into '${INSTALL_DIR}'"
		git clone --origin origin "${REPO_URL}" "${INSTALL_DIR}"
	fi

	if [[ -n "${REPO_REF}" ]]; then
		log "Checking out requested ref '${REPO_REF}'"
		git -C "${INSTALL_DIR}" fetch origin "${REPO_REF}"
		git -C "${INSTALL_DIR}" checkout --detach FETCH_HEAD
	else
		local branch
		branch="$(git -C "${INSTALL_DIR}" rev-parse --abbrev-ref HEAD)"
		if [[ "${branch}" == "HEAD" ]]; then
			warn "Detached HEAD detected; keeping current checkout (use --ref to set an explicit revision)"
		else
			log "Updating current branch '${branch}'"
			if ! git -C "${INSTALL_DIR}" pull --ff-only origin "${branch}"; then
				warn "Could not fast-forward '${branch}'. Keeping current checkout in '${INSTALL_DIR}'."
			fi
		fi
	fi
}

install_dependencies() {
	log "Installing dependencies with npm ci"
	local previous_dir
	previous_dir="$(pwd)"
	cd "${INSTALL_DIR}"
	set +e
	trap - ERR
	npm ci
	local status=$?
	trap 'on_error "$LINENO"' ERR
	set -e
	cd "${previous_dir}"
	if [[ "${status}" -eq 0 ]]; then
		return
	fi
	if [[ "${status}" -eq 137 ]]; then
		die "npm ci was killed by the OS, usually because the system ran out of memory. Free RAM/add swap and rerun the installer."
	fi
	die "npm ci failed with exit code ${status}."
}

start_app_if_requested() {
	if (( START_AFTER_INSTALL == 1 )); then
		log "Starting WA2DC (npm start)"
		cd "${INSTALL_DIR}"
		exec npm start
	fi
}

main() {
	detect_os
	ensure_node
	ensure_git
	require_cmd npm
	clone_or_update_repo
	install_dependencies

	log "Install/update completed successfully."
	log "Next step: cd ${INSTALL_DIR} && npm start"
	start_app_if_requested
}

main "$@"
