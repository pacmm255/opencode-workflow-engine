#!/usr/bin/env bash
# Download this file completely before executing it. Requires macOS or Linux.
set -Eeuo pipefail
umask 077

workflow_die() { printf 'Installation stopped: %s\n' "$*" >&2; exit 1; }

workflow_cleanup() {
  if [[ -n "${workflow_lock_dir:-}" ]]; then
    rmdir "$workflow_lock_dir" 2>/dev/null || true
  fi
}

workflow_main() {
  [[ $# -eq 0 ]] || workflow_die 'This installer takes no arguments.'
  local workflow_command workflow_root workflow_config_dir workflow_release workflow_commit
  for workflow_command in bun gh git opencode; do
    command -v "$workflow_command" >/dev/null 2>&1 || workflow_die "Install $workflow_command first, then retry."
  done
  gh auth status --hostname github.com >/dev/null 2>&1 || workflow_die 'Run gh auth login, then retry with an account that can access this repository.'
  bun -e 'const v = process.argv[1].trim(); if (!/^\d+\.\d+\.\d+/.test(v) || !Bun.semver.satisfies(v, ">=1.18.29")) process.exit(1)' "$(opencode --version)" \
    || workflow_die 'OpenCode 1.18.29 or later is required.'

  workflow_root=$(bun -e '
    const { isAbsolute, join, resolve } = require("node:path");
    const { homedir } = require("node:os");
    const override = process.env.WORKFLOW_INSTALL_ROOT;
    if (override && !isAbsolute(override)) throw new Error("WORKFLOW_INSTALL_ROOT must be absolute");
    const base = process.env.XDG_DATA_HOME;
    const root = resolve(override || join(base && isAbsolute(base) ? base : join(homedir(), ".local", "share"), "opencode", "workflow-engine"));
    if (root === resolve("/") || root === homedir()) throw new Error("Use a dedicated installation directory");
    console.log(root);
  ')
  workflow_config_dir=$(bun -e '
    const { isAbsolute, join, resolve } = require("node:path");
    const { homedir } = require("node:os");
    const override = process.env.WORKFLOW_CONFIG_DIR;
    if (override && !isAbsolute(override)) throw new Error("WORKFLOW_CONFIG_DIR must be absolute");
    const base = process.env.XDG_CONFIG_HOME;
    console.log(resolve(override || join(base && isAbsolute(base) ? base : join(homedir(), ".config"), "opencode")));
  ')

  [[ ! -L "$workflow_root" ]] || workflow_die 'The installation root must not be a symlink.'
  if [[ -e "$workflow_root" ]]; then
    [[ -d "$workflow_root" && -f "$workflow_root/.workflow-engine-owner" && ! -L "$workflow_root/.workflow-engine-owner" ]] \
      || workflow_die 'The installation directory already exists and is not managed by this installer.'
    [[ "$(< "$workflow_root/.workflow-engine-owner")" == 'pacmm255/opencode-workflow-engine' ]] \
      || workflow_die 'The installation directory belongs to another project.'
  else
    mkdir -p "$workflow_root"
    printf '%s\n' 'pacmm255/opencode-workflow-engine' > "$workflow_root/.workflow-engine-owner"
  fi
  workflow_lock_dir="$workflow_root/.install-lock"
  if ! mkdir "$workflow_lock_dir" 2>/dev/null; then
    workflow_lock_dir=''
    workflow_die 'Another installation may be running. If an earlier process was killed, remove its empty .install-lock directory after confirming it has exited.'
  fi
  trap workflow_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ ! -L "$workflow_root/releases" ]] || workflow_die 'The releases directory must not be a symlink.'
  mkdir -p "$workflow_root/releases"
  # Every build gets a new directory. Existing installs and edits are never reset.
  workflow_release=$(mktemp -d "$workflow_root/releases/release.XXXXXX")
  printf '%s\n' 'Downloading OpenCode Workflow Engine from private GitHub…'
  GH_HOST=github.com gh repo clone github.com/pacmm255/opencode-workflow-engine "$workflow_release" -- --depth 1 --single-branch --branch main
  (
    cd "$workflow_release"
    bun install --frozen-lockfile
    bun run bundle
  )
  for workflow_command in server tui worker; do
    [[ -s "$workflow_release/dist/$workflow_command.js" ]] || workflow_die "Missing built $workflow_command entry. The previous installation is unchanged."
  done
  [[ -s "$workflow_release/dist/skills/workflow-authoring/SKILL.md" ]] || workflow_die 'The authoring reference was not built.'

  bun run "$workflow_release/scripts/configure.ts" --config-dir "$workflow_config_dir" --plugin-dir "$workflow_root/current" --check
  # Atomic pointer replacement; reject unrelated existing files or links.
  # JavaScript owns the template interpolation inside this quoted program.
  # shellcheck disable=SC2016
  bun -e '
    const { lstatSync, readlinkSync, symlinkSync, renameSync, unlinkSync } = require("node:fs");
    const { dirname, basename, join, resolve } = require("node:path");
    const { randomUUID } = require("node:crypto");
    const [release, current] = process.argv.slice(1);
    let previous;
    try { previous = lstatSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (previous) {
      if (!previous.isSymbolicLink()) throw new Error("Refusing to replace an unrelated current entry");
      const target = resolve(dirname(current), readlinkSync(current));
      if (dirname(target) !== dirname(release) || !/^release\.[A-Za-z0-9]+$/.test(basename(target))) throw new Error("Refusing to replace an unmanaged current link");
      let targetInfo;
      try { targetInfo = lstatSync(target); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (targetInfo && !targetInfo.isDirectory()) throw new Error("The previous release must be a real directory, not a symlink");
    }
    const temporary = join(dirname(current), `.current-${randomUUID()}`);
    symlinkSync(release, temporary);
    try { renameSync(temporary, current); } finally {
      try { unlinkSync(temporary); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  ' "$workflow_release" "$workflow_root/current"
  # Keep the valid built release available even if a later configuration write
  # fails: an already-registered entry must not become a dangling file URL.
  bun run "$workflow_release/scripts/configure.ts" --config-dir "$workflow_config_dir" --plugin-dir "$workflow_root/current"
  workflow_commit=$(git -C "$workflow_release" rev-parse --short HEAD)
  printf '\nInstalled OpenCode Workflow Engine (%s).\n' "$workflow_commit"
  printf '%s\n' 'Server and native dialogs are enabled globally. Restart OpenCode, then run /workflow.'
  printf '%s\n' 'Existing configuration backups and previous build directories are retained locally.'
  if [[ -n "${OPENCODE_CONFIG:-}${OPENCODE_CONFIG_DIR:-}${OPENCODE_TUI_CONFIG:-}" ]]; then
    printf '%s\n' 'Note: custom OpenCode configuration overrides are set; those layers may override the global registration.'
  fi
}

workflow_main "$@"
