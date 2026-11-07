#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

from=
profile=
vault=
prefix_home=
allowed_signers=
yes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from|--profile|--vault|--prefix-home|--allowed-signers)
      option=$1
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf '%s\n' "E_ARGUMENT: Missing value for $option." >&2; exit 1; }
      case "$option" in
        --from) from=$2 ;;
        --profile) profile=$2 ;;
        --vault) vault=$2 ;;
        --prefix-home) prefix_home=$2 ;;
        --allowed-signers) allowed_signers=$2 ;;
      esac
      shift 2
      ;;
    --yes) yes=1; shift ;;
    *) printf '%s\n' 'E_ARGUMENT: Unknown install option.' >&2; exit 1 ;;
  esac
done

[ -n "$from" ] || { printf '%s\n' 'E_ARGUMENT: Use --from <tgz> for offline installation.' >&2; exit 1; }
if [ -n "$profile" ]; then
  case "$profile" in lite|full|custom) ;; *) printf '%s\n' 'E_ARGUMENT: Invalid profile.' >&2; exit 1 ;; esac
fi
command -v node >/dev/null 2>&1 || { printf '%s\n' 'E_NODE_VERSION: Node.js 20 or later is required.' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { printf '%s\n' 'E_NODE_VERSION: Node.js 20 or later is required.' >&2; exit 1; }
if [ "$yes" -ne 1 ]; then
  [ -t 0 ] || { printf '%s\n' 'E_ARGUMENT: Pass --yes for non-interactive installation.' >&2; exit 1; }
  printf '%s' 'Install BrainAtlas from the local release archive? [y/N] '
  IFS= read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) printf '%s\n' 'E_CANCELLED: Installation cancelled.' >&2; exit 1 ;; esac
fi

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
node_path=$(node -p 'process.execPath')
if [ -n "$prefix_home" ]; then
  mkdir -p "$prefix_home"
  HOME=$(CDPATH= cd "$prefix_home" && pwd)
  export HOME
fi
home=${HOME:?}
if [ -n "${BRAINATLAS_PLATFORM:-}" ]; then platform=$BRAINATLAS_PLATFORM
else
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) printf '%s\n' 'E_PLATFORM: Unsupported platform.' >&2; exit 1 ;; esac
fi
case "$platform" in
  darwin) data_dir=$home/Library/'Application Support'/BrainAtlas ;;
  linux) data_home=${XDG_DATA_HOME:-$home/.local/share}; data_dir=$data_home/brainatlas ;;
  *) printf '%s\n' 'E_PLATFORM: Unsupported platform.' >&2; exit 1 ;;
esac

old_current=
if [ -L "$data_dir/current" ]; then
  old_current=$(readlink "$data_dir/current")
  case "$old_current" in releases/[A-Za-z0-9]*) ;; *) printf '%s\n' 'E_CURRENT_INVALID: Current release link is invalid.' >&2; exit 1 ;; esac
  case "$old_current" in *..*|*/*/*) printf '%s\n' 'E_CURRENT_INVALID: Current release link is invalid.' >&2; exit 1 ;; esac
elif [ -e "$data_dir/current" ]; then
  printf '%s\n' 'E_CURRENT_INVALID: Current release path is not a link.' >&2
  exit 1
fi

if [ -n "$allowed_signers" ]; then signer_file=$allowed_signers
elif [ -n "${BRAINATLAS_ALLOWED_SIGNERS:-}" ]; then signer_file=$BRAINATLAS_ALLOWED_SIGNERS
else signer_file=$script_dir/release/allowed_signers
fi
mkdir -p "$data_dir/releases"
archive_info=$(node "$script_dir/release/install-archive.mjs" --archive "$from" --destination "$data_dir/releases/.staging-$$" --allowed-signers "$signer_file")
set -- $archive_info
[ "$#" -eq 2 ] || { printf '%s\n' 'E_MANIFEST_INVALID: Release metadata is invalid.' >&2; exit 1; }
version=$1
archive_profile=$2
case "$version" in *[!A-Za-z0-9._-]*|'') printf '%s\n' 'E_MANIFEST_INVALID: Release version is invalid.' >&2; exit 1 ;; esac
case "$archive_profile" in lite|full) ;; *) printf '%s\n' 'E_MANIFEST_INVALID: Release profile is invalid.' >&2; exit 1 ;; esac
if [ -n "$profile" ]; then
  case "$profile" in lite|full|custom) ;; *) printf '%s\n' 'E_ARGUMENT: Invalid profile.' >&2; exit 1 ;; esac
  init_profile=$profile
else init_profile=$archive_profile
fi

releases_dir=$data_dir/releases
staging=$releases_dir/.staging-$$
release=$releases_dir/$version
if [ -e "$release" ]; then
  rm -rf "$staging"
  printf '%s\n' 'E_RELEASE_EXISTS: Release version is already installed.' >&2
  exit 1
fi
mkdir -p "$data_dir/bin" "$home/.local/bin"
mv "$staging" "$release"
cli=$data_dir/current/packages/cli/bin/brainatlas.mjs
shim=$data_dir/bin/brainatlas
shim_tmp=$data_dir/bin/.brainatlas-$$
node "$script_dir/release/install-archive.mjs" --write-shim --file "$shim_tmp" --node "$node_path" --cli "$cli"
if [ -e "$shim" ] && [ ! -L "$shim" ]; then
  rm -f "$shim_tmp"; rm -rf "$release"
  printf '%s\n' 'E_PATH_CONFLICT: Application shim already exists.' >&2
  exit 1
fi
if [ -L "$shim" ]; then
  rm -f "$shim"
fi
mv "$shim_tmp" "$shim"

link_tool() {
  link=$1
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$shim" ] || { printf '%s\n' 'E_PATH_CONFLICT: Command link already exists.' >&2; return 1; }
    rm -f "$link"
  elif [ -e "$link" ]; then
    printf '%s\n' 'E_PATH_CONFLICT: Command path already exists.' >&2
    return 1
  fi
  ln -s "$shim" "$link"
}
link_tool "$home/.local/bin/brainatlas"
link_tool "$home/.local/bin/ba"

node "$script_dir/release/install-archive.mjs" --switch-link --link "$data_dir/current" --target "releases/$version"

set -- "$shim" init --yes --profile "$init_profile"
if [ -n "$vault" ]; then set -- "$@" --vault "$vault"; fi
if BRAINATLAS_OFFLINE=1 "$@"; then
  exit 0
else
  if [ -n "$old_current" ]; then
    node "$script_dir/release/install-archive.mjs" --switch-link --link "$data_dir/current" --target "$old_current"
  else rm -f "$data_dir/current"; fi
  printf '%s\n' 'E_INIT_FAILED: Initialization failed; previous release restored.' >&2
  exit 1
fi
