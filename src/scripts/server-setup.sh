# Server installation script

TMP_DIR=

DISTRO_VERSION="%%DISTRO_VERSION%%"
DISTRO_COMMIT="%%DISTRO_COMMIT%%"
DISTRO_QUALITY="%%DISTRO_QUALITY%%"
DISTRO_VSCODIUM_RELEASE="%%DISTRO_VSCODIUM_RELEASE%%"

SERVER_APP_NAME="%%SERVER_APP_NAME%%"
SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
SERVER_INITIAL_EXTENSION_IDS=(%%SERVER_INITIAL_EXTENSION_IDS%%)
SERVER_LISTEN_FLAG=
SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_METADATA_PREFIX="$SERVER_DATA_DIR/.$DISTRO_COMMIT"
SERVER_ACTIVEFILE="$SERVER_METADATA_PREFIX.active"
SERVER_GENERATION=
SERVER_LOGFILE="$SERVER_METADATA_PREFIX.log"
SERVER_PIDFILE="$SERVER_METADATA_PREFIX.pid"
SERVER_TOKENFILE="$SERVER_METADATA_PREFIX.token"
SERVER_GENERATION_ID="%%SCRIPT_ID%%"
REPLACE_SERVER_ENDPOINT=%%REPLACE_SERVER_ENDPOINT%%
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=
SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=
MANAGEMENT_CONNECTION_COUNT=0
LOCKDIR_HELD=false
ROTATED_SERVER=false

select_server_metadata() {
  SERVER_GENERATION=
  if [[ -s "$SERVER_ACTIVEFILE" ]]; then
    SERVER_GENERATION="$(cat "$SERVER_ACTIVEFILE" 2>/dev/null)"
  fi
  if ! [[ "$SERVER_GENERATION" =~ ^[a-f0-9]+$ ]]; then
    SERVER_GENERATION=
  fi

  SERVER_METADATA_SUFFIX="${SERVER_GENERATION:+.$SERVER_GENERATION}"
  SERVER_LOGFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.log"
  SERVER_PIDFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.pid"
  SERVER_TOKENFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.token"
}

select_new_server_generation() {
  SERVER_GENERATION="$SERVER_GENERATION_ID"
  SERVER_METADATA_SUFFIX=".$SERVER_GENERATION"
  SERVER_LOGFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.log"
  SERVER_PIDFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.pid"
  SERVER_TOKENFILE="$SERVER_METADATA_PREFIX$SERVER_METADATA_SUFFIX.token"
  ROTATED_SERVER=true
}

select_tmp_dir() {
  if [[ -n "${XDG_RUNTIME_DIR:-}" && -d "$XDG_RUNTIME_DIR" && -w "$XDG_RUNTIME_DIR" && -x "$XDG_RUNTIME_DIR" ]]; then
    TMP_DIR="$XDG_RUNTIME_DIR"
    return 0
  fi

  if [[ -d /tmp && -w /tmp && -x /tmp ]]; then
    if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
      echo "Warning: XDG_RUNTIME_DIR is not a usable directory; falling back to /tmp" >&2
    fi
    TMP_DIR=/tmp
    return 0
  fi

  return 1
}

release_install_lock() {
  if [[ "$LOCKDIR_HELD" == "true" ]]; then
    rm -f "$LOCKDIR/pid" 2>/dev/null || true
    rmdir "$LOCKDIR" 2>/dev/null || true
    LOCKDIR_HELD=false
  fi
}

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
  echo "%%SCRIPT_ID%%: start"
  echo "exitCode==$1=="
  echo "listeningOn==$LISTENING_ON=="
  echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
  echo "logFile==$SERVER_LOGFILE=="
  echo "osReleaseId==$OS_RELEASE_ID=="
  echo "arch==$ARCH=="
  echo "platform==$PLATFORM=="
  echo "tmpDir==$TMP_DIR=="
  echo "managementConnectionCount==$MANAGEMENT_CONNECTION_COUNT=="
%%ENV_VAR_LINES%%
  echo "%%SCRIPT_ID%%: end"
  release_install_lock
  exit 0
}

if ! select_tmp_dir; then
  echo "Error: neither XDG_RUNTIME_DIR nor /tmp is a usable temporary directory" >&2
  print_install_results_and_exit 1
fi

# The remote server and shells spawned by it must not inherit a stale runtime
# directory. This also prevents tools such as fnm from creating IPC links in a
# path that does not exist.
export XDG_RUNTIME_DIR="$TMP_DIR"

SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"

LOCKFILE="$TMP_DIR/open-remote-ssh-server-install-$USER.lock"
LOCKDIR="$LOCKFILE.d"

if command -v flock >/dev/null 2>&1; then
  # Automatic file descriptor allocation ({FD}) requires bash >= 4.1,
  # and macOS still ships bash 3.2, so use a fixed descriptor instead.
  FD=9
  if ! { exec 9<>"$LOCKFILE"; }; then
    echo "Warning: cannot open the server install lock" >&2
    print_install_results_and_exit 1
  fi

  if flock --help 2>&1 | grep -q -- '-w'; then
    # wait 30s to acquire lock, otherwise fail
    flock -x -w 30 $FD || print_install_results_and_exit 1
  else
    ELAPSED=0

    while [[ $ELAPSED -lt 30 ]]; do
        if flock -n -x $FD; then
            break
        fi

        sleep 1

        ELAPSED=$((ELAPSED + 1))
    done

    if [[ $ELAPSED -ge 30 ]]; then
      echo "Warning: flock cannot acquire the install lock"
      print_install_results_and_exit 1
    fi
  fi

  trap 'flock -u 9; trap - EXIT INT HUP; exit' EXIT INT HUP
else
  ELAPSED=0
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    LOCK_OWNER="$(cat "$LOCKDIR/pid" 2>/dev/null)"
    if [[ $LOCK_OWNER =~ ^[0-9]+$ ]] && ! kill -0 "$LOCK_OWNER" 2>/dev/null; then
      rm -f "$LOCKDIR/pid" 2>/dev/null || true
      rmdir "$LOCKDIR" 2>/dev/null || true
      continue
    fi
    # A process can die between mkdir and writing its pid. Give a live owner a
    # brief grace period, then reclaim an empty or corrupt lock directory.
    if [[ $ELAPSED -ge 10 ]] && ! [[ $LOCK_OWNER =~ ^[0-9]+$ ]]; then
      rm -f "$LOCKDIR/pid" 2>/dev/null || true
      rmdir "$LOCKDIR" 2>/dev/null || true
      continue
    fi
    if [[ $ELAPSED -ge 300 ]]; then
      echo "Warning: cannot acquire the portable install lock"
      print_install_results_and_exit 1
    fi
    sleep 0.1
    ELAPSED=$((ELAPSED + 1))
  done
  LOCKDIR_HELD=true
  if ! echo $$ > "$LOCKDIR/pid"; then
    release_install_lock
    echo "Warning: cannot record the portable install lock owner"
    print_install_results_and_exit 1
  fi
  trap 'release_install_lock; trap - EXIT INT HUP; exit' EXIT INT HUP
fi

# Read the active generation only after taking the install lock. Concurrent
# resolver retries can then agree on one replacement without killing or
# overwriting the token files of an Agent still serving another window.
select_server_metadata

# Check if platform is supported
if ! command -v uname >/dev/null 2>&1; then
  echo "Error: 'uname' command not found, could not get platform/arch data."
  print_install_results_and_exit 1
fi

KERNEL="$(uname -s)"
case $KERNEL in
  Darwin)
    PLATFORM="darwin"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  FreeBSD)
    PLATFORM="freebsd"
    ;;
  DragonFly)
    PLATFORM="dragonfly"
    ;;
  "")
    echo "Error: uname -s yields empty result"
    print_install_results_and_exit 1
    ;;
  *)
    echo "Error: platform not supported: $KERNEL"
    print_install_results_and_exit 1
    ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
  x86_64 | amd64)
    SERVER_ARCH="x64"
    ;;
  armv7l | armv8l)
    SERVER_ARCH="armhf"
    ;;
  arm64 | aarch64)
    SERVER_ARCH="arm64"
    ;;
  ppc64le)
    SERVER_ARCH="ppc64le"
    ;;
  riscv64)
    SERVER_ARCH="riscv64"
    ;;
  loongarch64)
    SERVER_ARCH="loong64"
    ;;
  s390x)
    SERVER_ARCH="s390x"
    ;;
  *)
    echo "Error: architecture not supported: $ARCH"
    print_install_results_and_exit 1
    ;;
esac

# https://www.freedesktop.org/software/systemd/man/os-release.html
OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z $OS_RELEASE_ID ]]; then
  OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
  if [[ -z $OS_RELEASE_ID ]]; then
    OS_RELEASE_ID="unknown"
  fi
fi

# Create installation folder
if [[ ! -d $SERVER_DIR ]]; then
  mkdir -p $SERVER_DIR
  if (( $? > 0 )); then
    echo "Error: creating server install directory"
    print_install_results_and_exit 1
  fi
fi

# adjust platform for vscodium download, if needed
if [[ $OS_RELEASE_ID = alpine ]]; then
  PLATFORM=$OS_RELEASE_ID
fi

SERVER_DOWNLOAD_URL="$(echo "%%SERVER_DOWNLOAD_URL_TEMPLATE%%" | sed "s/\${quality}/$DISTRO_QUALITY/g" | sed "s/\${version}/$DISTRO_VERSION/g" | sed "s/\${commit}/$DISTRO_COMMIT/g" | sed "s/\${os}/$PLATFORM/g" | sed "s/\${arch}/$SERVER_ARCH/g" | sed "s/\${release}/$DISTRO_VSCODIUM_RELEASE/g")"

# Check if server script is already installed
if [[ ! -f $SERVER_SCRIPT ]]; then
  case "$PLATFORM" in
    darwin | linux | alpine | freebsd )
      ;;
    *)
      echo "Error: '$PLATFORM' needs manual installation of remote extension host"
      print_install_results_and_exit 1
      ;;
  esac

  pushd $SERVER_DIR > /dev/null

  if command -v wget >/dev/null 2>&1; then
    wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz $SERVER_DOWNLOAD_URL
  elif command -v curl >/dev/null 2>&1; then
    curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz $SERVER_DOWNLOAD_URL
  elif command -v fetch >/dev/null 2>&1; then
    fetch --retry --timeout=10 --quiet --output=vscode-server.tar.gz $SERVER_DOWNLOAD_URL
  else
    echo "Error: no tool to download server binary"
    print_install_results_and_exit 1
  fi

  if (( $? > 0 )); then
    echo "Error downloading server from $SERVER_DOWNLOAD_URL"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  tar -xOf vscode-server.tar.gz > /dev/null 2>&1
  if (( $? > 0 )); then
    echo "Error downloaded tarball is corrupt or incomplete"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  tar -xf vscode-server.tar.gz --strip-components 1
  if (( $? > 0 )); then
    echo "Error while extracting server contents"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  if [[ ! -f $SERVER_SCRIPT ]] || [[ ! -s $SERVER_SCRIPT ]]; then
    rm -rf $SERVER_DIR/*
    echo "Error: server contents are corrupted"
    print_install_results_and_exit 1
  fi

  rm -f vscode-server.tar.gz

  popd > /dev/null
else
  echo "Server script already installed in $SERVER_SCRIPT"
fi

# Modify the commit in the remote server to match the local value
if %%MODIFY_PRODUCT_JSON%%; then
  if command -v sed >/dev/null 2>&1; then
    echo "Will modify product.json on remote to match the commit value"
    sed -i -E 's/"commit": "[0-9a-f]+",/"commit": "'"$DISTRO_COMMIT"'",/' "$SERVER_DIR/product.json";
  else
    echo "Cannot find the 'sed' command, make sure it is installed to modify product.json with the matching commit."
  fi
fi

# Try to find if the active server generation is already running.
SERVER_RUNNING_PROCESS=
if [[ -f $SERVER_PIDFILE ]]; then
  SERVER_PID="$(cat $SERVER_PIDFILE)"
  SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
elif [[ ! -e $SERVER_ACTIVEFILE ]]; then
  # Compatibility fallback for server installations created before pid files
  # were reliable. Never use it after generation tracking has been enabled,
  # because it could select an older Agent that is intentionally draining.
  SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi


CURRENT_LISTENING_ON=
if [[ -s $SERVER_LOGFILE ]]; then
  CURRENT_LISTENING_ON="$(sed -n 's/^Extension host agent listening on //p' "$SERVER_LOGFILE" | tail -n 1)"
fi

if [[ -n $REPLACE_SERVER_ENDPOINT ]]; then
  if [[ -z $CURRENT_LISTENING_ON || $CURRENT_LISTENING_ON == "$REPLACE_SERVER_ENDPOINT" ]]; then
    echo "Rotating unhealthy server endpoint $REPLACE_SERVER_ENDPOINT to a new generation"
    select_new_server_generation
    SERVER_RUNNING_PROCESS=
  else
    echo "Another resolver already replaced server endpoint $REPLACE_SERVER_ENDPOINT with $CURRENT_LISTENING_ON"
  fi
fi

if [[ -n $SERVER_RUNNING_PROCESS ]]; then
  echo "Server script is already running $SERVER_SCRIPT"

  # --install-extension is only applied by --start-server when a new server
  # process is launched. Apply the requested defaults explicitly when reusing
  # an existing process so a changed defaultExtensions setting is not skipped.
  if (( ${#SERVER_INITIAL_EXTENSION_IDS[@]} > 0 )); then
    SERVER_EXTENSION_ARGUMENTS=()
    if [[ -n $SERVER_DATA_DIR_FLAG ]]; then
      SERVER_EXTENSION_ARGUMENTS+=(--server-data-dir="$SERVER_DATA_DIR")
    fi
    for EXTENSION_ID in "${SERVER_INITIAL_EXTENSION_IDS[@]}"; do
      SERVER_EXTENSION_ARGUMENTS+=(--install-extension "$EXTENSION_ID")
    done

    "$SERVER_SCRIPT" "${SERVER_EXTENSION_ARGUMENTS[@]}" --accept-server-license-terms
    if (( $? > 0 )); then
      echo "Error installing default extensions"
      print_install_results_and_exit 1
    fi
  fi
else
  if [[ -f $SERVER_LOGFILE ]]; then
    rm $SERVER_LOGFILE
  fi
  if [[ -f $SERVER_TOKENFILE ]]; then
    rm $SERVER_TOKENFILE
  fi

  touch $SERVER_TOKENFILE
  chmod 600 $SERVER_TOKENFILE
  SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

  $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
  echo $! > $SERVER_PIDFILE
fi

if [[ -f $SERVER_TOKENFILE ]]; then
  SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
  echo "Error: server token file not found $SERVER_TOKENFILE"
  print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
  for i in {1..35}; do
    if [[ -n "$(cat $SERVER_LOGFILE | grep 'Error loading shared library libstdc++.so')" ]]; then
      echo "Error: missing libstdc++"
      break;
    fi

    LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
    if [[ -n $LISTENING_ON ]]; then
      break
    fi

    sleep 0.5
  done

  if [[ -z $LISTENING_ON ]]; then
    echo "Error: server did not start successfully"
    print_install_results_and_exit 1
  fi
else
  echo "Error: server log file not found $SERVER_LOGFILE"
  print_install_results_and_exit 1
fi

if [[ "$ROTATED_SERVER" == "true" ]]; then
  SERVER_ACTIVEFILE_TMP="$SERVER_ACTIVEFILE.$SERVER_GENERATION.tmp"
  if ! printf '%s\n' "$SERVER_GENERATION" > "$SERVER_ACTIVEFILE_TMP" || ! mv -f "$SERVER_ACTIVEFILE_TMP" "$SERVER_ACTIVEFILE"; then
    rm -f "$SERVER_ACTIVEFILE_TMP" 2>/dev/null || true
    echo "Error: could not activate replacement server generation"
    print_install_results_and_exit 1
  fi
fi

MANAGEMENT_CONNECTION_COUNT="$(grep -cF '[ManagementConnection] New connection established.' "$SERVER_LOGFILE" 2>/dev/null || true)"
if ! [[ "$MANAGEMENT_CONNECTION_COUNT" =~ ^[0-9]+$ ]]; then
  MANAGEMENT_CONNECTION_COUNT=0
fi

# Finish server setup
print_install_results_and_exit 0
