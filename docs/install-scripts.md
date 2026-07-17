# Installer Scripts

These scripts automate source installation/update for WA2DC and enforce the current runtime requirement (`Node.js >=24`).

## Files

- `install_script.sh`: Linux and macOS installer (Bash)
- `install_script.ps1`: Windows installer (PowerShell)

## Quick Start

### Linux (Debian/Ubuntu)

```bash
chmod +x install_script.sh
./install_script.sh
```

### macOS

```bash
chmod +x install_script.sh
./install_script.sh
```

> macOS bootstrap uses Homebrew. If Homebrew is missing, install it from https://brew.sh/.

### Windows (PowerShell)

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_script.ps1
```

The Windows script uses `winget` first, then falls back to `choco` if available.

## What The Scripts Do

1. Ensure Node.js `>=24` is installed.
2. Ensure `git` is installed.
3. Clone or update `https://github.com/arespawn/WhatsAppToDiscord.git`.
4. Install dependencies with `npm ci`.
5. Optionally start the bot.

## Options

Both scripts support equivalent options:

- Install directory:
  - Bash: `--dir <path>`
  - PowerShell: `-Dir <path>`
- Git ref (branch/tag/commit):
  - Bash: `--ref <git-ref>`
  - PowerShell: `-Ref <git-ref>`
- Repo override:
  - Bash: `--repo <url>`
  - PowerShell: `-Repo <url>`
- Start after install:
  - Bash: `--start`
  - PowerShell: `-Start`

Examples:

```bash
./install_script.sh --dir ./wa2dc --ref v2.3.0 --start
```

```powershell
.\install_script.ps1 -Dir .\wa2dc -Ref v2.3.0 -Start
```

## Notes

- Linux auto-bootstrap in `install_script.sh` currently supports Debian/Ubuntu-based distributions.
- Existing non-fast-forward git branches are preserved (the script warns and keeps the current checkout).
- If `node`, `npm`, or `git` are installed but not in `PATH` yet, open a new terminal and rerun.
- If `npm ci` is printed as `Killed` or exits with code 137, the OS likely killed it for low memory. Free RAM, add swap, or install on a larger host, then rerun the installer.
