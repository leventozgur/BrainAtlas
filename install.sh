#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

archive=
profile=
vault=
prefix_home=
allowed_signers=
yes=0
insecure=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from|--profile|--vault|--prefix-home|--allowed-signers)
      option=$1
      [ "$#" -ge 2 ] || { echo "E_ARGUMENT: missing value for $option." >&2; exit 1; }
      case "$2" in --*) echo "E_ARGUMENT: missing value for $option." >&2; exit 1 ;; esac
      case "$option" in
        --from) archive=$2 ;;
        --profile) profile=$2 ;;
        --vault) vault=$2 ;;
        --prefix-home) prefix_home=$2 ;;
        --allowed-signers) allowed_signers=$2 ;;
      esac
      shift 2
      ;;
    --yes) yes=1; shift ;;
    --insecure-skip-signature) insecure=1; shift ;;
    *) echo "E_ARGUMENT: unknown installer option." >&2; exit 1 ;;
  esac
done

[ -n "$archive" ] || { echo "E_ARGUMENT: --from <release.tgz> is required for offline installation." >&2; exit 1; }
[ -f "$archive" ] || { echo "E_ARCHIVE_READ: release archive is unavailable." >&2; exit 1; }
if [ -n "$profile" ]; then case "$profile" in lite|full) ;; *) echo "E_ARGUMENT: profile is invalid." >&2; exit 1 ;; esac; fi

if [ -n "$prefix_home" ]; then
  case "$prefix_home" in /*) ;; *) echo "E_ARGUMENT: prefix HOME must be absolute." >&2; exit 1 ;; esac
  HOME=$prefix_home; export HOME
fi
[ -n "${HOME:-}" ] || { echo "E_NO_HOME: HOME must be set." >&2; exit 1; }
if [ -n "${BRAINATLAS_PLATFORM:-}" ]; then platform=$BRAINATLAS_PLATFORM
else
  system=$(uname -s)
  case "$system" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo "E_PLATFORM: unsupported platform." >&2; exit 1 ;; esac
fi
case "$platform" in darwin|linux) ;; *) echo "E_PLATFORM: unsupported platform." >&2; exit 1 ;; esac
export BRAINATLAS_PLATFORM=$platform
if [ -n "$prefix_home" ]; then
  case "${XDG_DATA_HOME:-}" in "$HOME"/*) ;; *) XDG_DATA_HOME="$HOME/.local/share"; export XDG_DATA_HOME ;; esac
  case "${XDG_CONFIG_HOME:-}" in "$HOME"/*) ;; *) XDG_CONFIG_HOME="$HOME/.config"; export XDG_CONFIG_HOME ;; esac
  case "${XDG_STATE_HOME:-}" in "$HOME"/*) ;; *) XDG_STATE_HOME="$HOME/.local/state"; export XDG_STATE_HOME ;; esac
fi

node_bin=${NODE:-node}
if ! command -v "$node_bin" >/dev/null 2>&1; then echo "E_NODE_VERSION: Node.js 20 or newer is required." >&2; exit 1; fi
node_major=$("$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
case "$node_major" in *[!0-9]*|'') node_major=0 ;; esac
[ "$node_major" -ge 20 ] || { echo "E_NODE_VERSION: Node.js 20 or newer is required." >&2; exit 1; }

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
helper="$script_dir/release/install-archive.mjs"
[ -f "$helper" ] || { echo "E_INSTALL: release verification helper is unavailable." >&2; exit 1; }
if [ -z "$allowed_signers" ]; then
  allowed_signers=${BRAINATLAS_ALLOWED_SIGNERS:-$script_dir/release/allowed_signers}
fi
verify_dir=${TMPDIR:-/tmp}/brainatlas-install-verify-$$
if [ "$insecure" -eq 1 ]; then
  echo "WARNING: release signature verification is disabled by explicit request." >&2
  signer_arg=${allowed_signers:-/dev/null}
  release_info=$(BRAINATLAS_INSECURE_SKIP_SIGNATURE=1 "$node_bin" "$helper" --archive "$archive" --destination "$verify_dir" --allowed-signers "$signer_arg") || exit 1
else
  command -v ssh-keygen >/dev/null 2>&1 || { echo "E_SIGNATURE_INVALID: ssh-keygen is required; use --insecure-skip-signature only when explicitly accepting this risk." >&2; exit 1; }
  [ -f "$allowed_signers" ] || { echo "E_SIGNATURE_INVALID: allowed signers file is unavailable." >&2; exit 1; }
  if ! release_info=$("$node_bin" "$helper" --archive "$archive" --destination "$verify_dir" --allowed-signers "$allowed_signers"); then
    rm -rf "$verify_dir"
    exit 1
  fi
fi
rm -rf "$verify_dir"
set -- $release_info
version=${1:-}
archive_profile=${2:-}
case "$version" in ''|*[!A-Za-z0-9._-]*) echo "E_MANIFEST_INVALID: release version is invalid." >&2; exit 1 ;; esac
if [ -n "$profile" ] && [ "$archive_profile" != "$profile" ]; then echo "E_PROFILE_MISMATCH: requested profile does not match the release." >&2; exit 1; fi
profile=$archive_profile

if [ "$platform" = darwin ]; then
  data_dir="$HOME/Library/Application Support/BrainAtlas"
else
  data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  data_dir="$data_home/brainatlas"
fi
release_dir="$data_dir/releases/$version"
current="$data_dir/current"
stage="$data_dir/releases/.staging-$$"
set --
probe="$data_dir/releases"
while [ ! -d "$probe" ]; do set -- --created-dir "$probe" "$@"; probe=$(dirname "$probe"); done
mkdir -p "$data_dir/releases"
[ ! -e "$release_dir" ] || { echo "E_RELEASE_EXISTS: release version is already installed." >&2; exit 1; }

if [ "$insecure" -eq 1 ]; then
  BRAINATLAS_INSECURE_SKIP_SIGNATURE=1 "$node_bin" "$helper" --archive "$archive" --destination "$stage" --allowed-signers "${allowed_signers:-/dev/null}" >/dev/null
else
  "$node_bin" "$helper" --archive "$archive" --destination "$stage" --allowed-signers "$allowed_signers" >/dev/null
fi
mv "$stage" "$release_dir"

if [ -e "$current" ] && [ ! -L "$current" ]; then
  echo "E_CURRENT_INVALID: current release path is not a symbolic link." >&2
  exit 1
fi
"$node_bin" "$helper" --switch-link --link "$current" --target "releases/$version"

export BRAINATLAS_ALLOWED_SIGNERS=$allowed_signers
cli="$current/packages/cli/bin/brainatlas.mjs"
"$node_bin" "$cli" install --finalize --json "$@" >/dev/null
if [ "$yes" -eq 1 ]; then
  if [ -n "$vault" ]; then "$node_bin" "$cli" init --yes --profile "$profile" --vault "$vault" --json >/dev/null
  else "$node_bin" "$cli" init --yes --profile "$profile" --json >/dev/null
  fi
else
  if [ -n "$vault" ]; then "$node_bin" "$cli" init --profile "$profile" --vault "$vault"
  else "$node_bin" "$cli" init --profile "$profile"
  fi
fi
exit 0
