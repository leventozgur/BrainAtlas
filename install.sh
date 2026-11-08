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
allow_symlinked_root=0

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
    --allow-symlinked-root) allow_symlinked_root=1; shift ;;
    *) echo "E_ARGUMENT: unknown installer option." >&2; exit 1 ;;
  esac
done

if [ "$allow_symlinked_root" -eq 1 ]; then
  BRAINATLAS_ALLOW_SYMLINKED_ROOT=1; export BRAINATLAS_ALLOW_SYMLINKED_ROOT
fi

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
helper="$script_dir/release/install-kit.mjs"
[ -f "$helper" ] || { echo "E_INSTALL: release verification helper is unavailable." >&2; exit 1; }
if [ -z "$allowed_signers" ]; then
  allowed_signers=${BRAINATLAS_ALLOWED_SIGNERS:-$script_dir/release/allowed_signers}
fi

# Distribution kits list every payload file in SHA256SUMS. Verify the signed
# list and its files before executing the packaged helper. Source checkouts
# remain usable with profile archives built directly by buildRelease().
kit_sums="$script_dir/SHA256SUMS"
kit_signature="$kit_sums.sig"
kit_mode=0
if [ -f "$kit_sums" ] && grep -q '  install.sh$' "$kit_sums"; then kit_mode=1; fi
if [ "$kit_mode" -eq 1 ]; then
  [ -f "$kit_signature" ] || { echo "E_SIGNATURE_INVALID: release signature is unavailable." >&2; exit 1; }
  if [ "$insecure" -eq 0 ]; then
    command -v ssh-keygen >/dev/null 2>&1 || { echo "E_SIGNATURE_INVALID: ssh-keygen is required." >&2; exit 1; }
    [ -f "$allowed_signers" ] || { echo "E_SIGNATURE_INVALID: allowed signers file is unavailable." >&2; exit 1; }
    if ! ssh-keygen -Y verify -f "$allowed_signers" -I brainatlas-release -n brainatlas-release -s "$kit_signature" < "$kit_sums" >/dev/null 2>&1; then
      echo "E_SIGNATURE_INVALID: release signature is invalid." >&2; exit 1
    fi
  else
    echo "WARNING: release signature verification is disabled by explicit request." >&2
  fi
  seen=' '
  listed_archive=0
  while IFS=' ' read -r expected filename; do
    [ -n "$expected" ] && [ -n "$filename" ] || { echo "E_MANIFEST_INVALID: release checksum list is invalid." >&2; exit 1; }
    case "$expected" in *[!a-f0-9]*) echo "E_MANIFEST_INVALID: release checksum list is invalid." >&2; exit 1 ;; esac
    [ "${#expected}" -eq 64 ] || { echo "E_MANIFEST_INVALID: release checksum list is invalid." >&2; exit 1; }
    case "$filename" in /*|..|../*|*/..|*/../*|*\\*|*' '*) echo "E_MANIFEST_INVALID: release checksum list is invalid." >&2; exit 1 ;; esac
    case "$seen" in *" $filename "*) echo "E_MANIFEST_INVALID: release checksum list is invalid." >&2; exit 1 ;; esac
    seen="$seen$filename "
    file="$script_dir/$filename"
    [ -f "$file" ] || { echo "E_SHA_MISMATCH: a release kit file is unavailable." >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file"); actual=${actual%% *}
    elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$file"); actual=${actual%% *}
    else echo "E_SHA_MISMATCH: a SHA-256 utility is required." >&2; exit 1
    fi
    [ "$actual" = "$expected" ] || { echo "E_SHA_MISMATCH: a release kit file changed." >&2; exit 1; }
    [ "$filename" = "$(basename "$archive")" ] && listed_archive=1
  done < "$kit_sums"
  [ "$listed_archive" -eq 1 ] || { echo "E_SHA_MISMATCH: selected release archive is not in the distribution kit." >&2; exit 1; }
fi

if [ "$platform" = darwin ]; then
  data_dir="$HOME/Library/Application Support/BrainAtlas"
else
  data_home=${XDG_DATA_HOME:-$HOME/.local/share}
  data_dir="$data_home/brainatlas"
fi
root_path_status=$("$node_bin" "$helper" --check-install-root "$data_dir" --check-install-root "$data_dir/releases" --check-install-root "$data_dir/current")

if [ "$insecure" -eq 1 ]; then
  [ "$kit_mode" -eq 1 ] || echo "WARNING: release signature verification is disabled by explicit request." >&2
  signer_arg=${allowed_signers:-/dev/null}
  release_info=$(BRAINATLAS_INSECURE_SKIP_SIGNATURE=1 "$node_bin" "$helper" --inspect "$archive" --allowed-signers "$signer_arg") || exit 1
else
  command -v ssh-keygen >/dev/null 2>&1 || { echo "E_SIGNATURE_INVALID: ssh-keygen is required; use --insecure-skip-signature only when explicitly accepting this risk." >&2; exit 1; }
  [ -f "$allowed_signers" ] || { echo "E_SIGNATURE_INVALID: allowed signers file is unavailable." >&2; exit 1; }
  if ! release_info=$("$node_bin" "$helper" --inspect "$archive" --allowed-signers "$allowed_signers"); then exit 1; fi
fi
set -- $release_info
version=${1:-}
archive_profile=${2:-}
case "$version" in ''|*[!A-Za-z0-9._-]*) echo "E_MANIFEST_INVALID: release version is invalid." >&2; exit 1 ;; esac
if [ -n "$profile" ] && [ "$archive_profile" != "$profile" ]; then echo "E_PROFILE_MISMATCH: requested profile does not match the release." >&2; exit 1; fi
profile=$archive_profile

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
if [ "$root_path_status" = symlinked-root ]; then
  finalize_home=$("$node_bin" "$helper" --resolve-path "$data_dir")
  HOME=$finalize_home "$node_bin" "$cli" install --finalize --json "$@" >/dev/null
else
  "$node_bin" "$cli" install --finalize --json "$@" >/dev/null
fi
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
