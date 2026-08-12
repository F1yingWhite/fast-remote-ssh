# Server installation script

$TMP_DIR="$env:TEMP\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_VERSION="%%DISTRO_VERSION%%"
$DISTRO_COMMIT="%%DISTRO_COMMIT%%"
$DISTRO_QUALITY="%%DISTRO_QUALITY%%"
$DISTRO_VSCODIUM_RELEASE="%%DISTRO_VSCODIUM_RELEASE%%"

$SERVER_APP_NAME="%%SERVER_APP_NAME%%"
$SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
$SERVER_INITIAL_EXTENSION_IDS=@(%%SERVER_INITIAL_EXTENSION_IDS%%)
$SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
$SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
$SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
$SERVER_DIR="$SERVER_DATA_DIR\bin\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\bin\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.token"
$SERVER_ARCH=$null
$SERVER_CONNECTION_TOKEN=$null
$SERVER_DOWNLOAD_URL="%%SERVER_DOWNLOAD_URL%%"
$SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

$LISTENING_ON=$null
$OS_RELEASE_ID=$null
$ARCH=$null
$PLATFORM="win32"

function printInstallResults($code) {
  "%%SCRIPT_ID%%: start"
  "exitCode==$code=="
  "listeningOn==$LISTENING_ON=="
  "connectionToken==$SERVER_CONNECTION_TOKEN=="
  "logFile==$SERVER_LOGFILE=="
  "osReleaseId==$OS_RELEASE_ID=="
  "arch==$ARCH=="
  "platform==$PLATFORM=="
  "tmpDir==$TMP_DIR=="
%%ENV_VAR_LINES%%
  "%%SCRIPT_ID%%: end"
}

$LOCK_MUTEX=$null
$LOCK_ACQUIRED=$false
try {
  $LOCK_HASHER=[Security.Cryptography.SHA256]::Create()
  try {
    $LOCK_KEY=[Convert]::ToBase64String($LOCK_HASHER.ComputeHash([Text.Encoding]::UTF8.GetBytes($SERVER_DATA_DIR))).Replace('/', '_').Replace('+', '-').TrimEnd('=')
  } finally {
    $LOCK_HASHER.Dispose()
  }
  $LOCK_NAME="Local\open-remote-ssh-server-install-$LOCK_KEY"
  $LOCK_MUTEX=New-Object System.Threading.Mutex($false, $LOCK_NAME)

  try {
    $LOCK_ACQUIRED=$LOCK_MUTEX.WaitOne([TimeSpan]::FromSeconds(120))
  } catch [System.Threading.AbandonedMutexException] {
    $LOCK_ACQUIRED=$true
  }

  if(!$LOCK_ACQUIRED) {
    "Warning: cannot acquire the server install lock"
    printInstallResults 1
    exit 0
  }

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
# Use x64 version for ARM64, as it's not yet available.
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
  $SERVER_ARCH="x64"
}
else {
  "Error architecture not supported: $ARCH"
  printInstallResults 1
  exit 0
}

# Create installation folder
if(!(Test-Path $SERVER_DIR)) {
  try {
    ni -it d $SERVER_DIR -f -ea si
  } catch {
    throw "Error creating server install directory - $($_.ToString())"
  }

  if(!(Test-Path $SERVER_DIR)) {
    throw "Error creating server install directory"
  }
}

cd $SERVER_DIR

# Check if server script is already installed
if(!(Test-Path $SERVER_SCRIPT)) {
  if(Test-Path vscode-server.tar.gz) {
    del vscode-server.tar.gz
  }

  $REQUEST_ARGUMENTS = @{
    Uri="$SERVER_DOWNLOAD_URL"
    TimeoutSec=20
    OutFile="vscode-server.tar.gz"
    UseBasicParsing=$True
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  Invoke-RestMethod @REQUEST_ARGUMENTS

  if(Test-Path "vscode-server.tar.gz") {
    tar -xOf vscode-server.tar.gz | Out-Null

    if($LastExitCode -ne 0) {
      del vscode-server.tar.gz
      throw "Error downloaded tarball is corrupt or incomplete"
    }

    tar -xf vscode-server.tar.gz --strip-components 1

    if($LastExitCode -ne 0) {
      del vscode-server.tar.gz
      throw "Error while extracting server contents"
    }

    del vscode-server.tar.gz
  }

  if(!(Test-Path $SERVER_SCRIPT)) {
    throw "Error while installing the server binary"
  }
}
else {
  "Server script already installed in $SERVER_SCRIPT"
}

# Modify the commit in the remote server to match the local value
if(%%MODIFY_PRODUCT_JSON%%) {
  echo "Will modify product.json on remote to match the commit value"
  (Get-Content -Raw "$SERVER_DIR\product.json") -replace '"commit": "[0-9a-f]+",', ('"commit": "' + $DISTRO_COMMIT + '",') |
  Set-Content -NoNewLine "$SERVER_DIR\product.json"
}

# Try to find if server is already running
$SERVER_RUNNING_PROCESS=Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\*"
if($SERVER_RUNNING_PROCESS) {
  echo "Server script is already running $SERVER_SCRIPT"

  # --install-extension is only applied by --start-server when a new server
  # process is launched. Apply the requested defaults explicitly when reusing
  # an existing process so a changed defaultExtensions setting is not skipped.
  if($SERVER_INITIAL_EXTENSION_IDS.Count -gt 0) {
    $SERVER_EXTENSION_ARGUMENTS=@()
    if($SERVER_DATA_DIR_FLAG) {
      $SERVER_EXTENSION_ARGUMENTS += "--server-data-dir=$SERVER_DATA_DIR"
    }
    foreach($EXTENSION_ID in $SERVER_INITIAL_EXTENSION_IDS) {
      $SERVER_EXTENSION_ARGUMENTS += "--install-extension"
      $SERVER_EXTENSION_ARGUMENTS += $EXTENSION_ID
    }
    $SERVER_EXTENSION_ARGUMENTS += "--accept-server-license-terms"

    & $SERVER_SCRIPT @SERVER_EXTENSION_ARGUMENTS
    if($LastExitCode -ne 0) {
      "Error installing default extensions"
      printInstallResults 1
      exit 0
    }
  }
}
else {
  if(Test-Path $SERVER_LOGFILE) {
    del $SERVER_LOGFILE
  }
  if(Test-Path $SERVER_PIDFILE) {
    del $SERVER_PIDFILE
  }
  if(Test-Path $SERVER_TOKENFILE) {
    del $SERVER_TOKENFILE
  }

  $SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

  $SERVER_ARGUMENTS=@("--start-server", "--host=127.0.0.1", $SERVER_LISTEN_FLAG)
  if($SERVER_DATA_DIR_FLAG) {
    $SERVER_ARGUMENTS += "--server-data-dir=$SERVER_DATA_DIR"
  }
  if($SERVER_VALIDATION_FLAG) {
    $SERVER_ARGUMENTS += $SERVER_VALIDATION_FLAG
  }
  foreach($EXTENSION_ID in $SERVER_INITIAL_EXTENSION_IDS) {
    $SERVER_ARGUMENTS += "--install-extension"
    $SERVER_ARGUMENTS += $EXTENSION_ID
  }
  $SERVER_ARGUMENTS += @("--connection-token-file", $SERVER_TOKENFILE, "--telemetry-level", "off", "--enable-remote-auto-shutdown", "--accept-server-license-terms")

  $ESCAPED_SERVER_SCRIPT=$SERVER_SCRIPT.Replace("'", "''")
  $ESCAPED_SERVER_LOGFILE=$SERVER_LOGFILE.Replace("'", "''")
  $ESCAPED_SERVER_ARGUMENTS=$SERVER_ARGUMENTS | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
  $SERVER_COMMAND="& '$ESCAPED_SERVER_SCRIPT' $($ESCAPED_SERVER_ARGUMENTS -join ' ') *> '$ESCAPED_SERVER_LOGFILE'"
  $SERVER_ENCODED_COMMAND=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($SERVER_COMMAND))

  $START_ARGUMENTS = @{
    FilePath = "powershell.exe"
    WindowStyle = "hidden"
    ArgumentList = @(
      "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $SERVER_ENCODED_COMMAND
    )
    PassThru = $True
  }

  $SERVER_ID = (start @START_ARGUMENTS).ID

  if($SERVER_ID) {
    [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
  }
}

if(Test-Path $SERVER_TOKENFILE) {
  $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
  "Error server token file not found $SERVER_TOKENFILE"
  printInstallResults 1
  exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
  Path = $SERVER_LOGFILE
  Pattern = "Extension host agent listening on (\d+)"
}

for($I = 1; $I -le 35; $I++) {
  if(Test-Path $SERVER_LOGFILE) {
    $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

    if($GROUPS) {
      $LISTENING_ON = $GROUPS[1].Value
      break
    }
  }

  sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
  "Error server log file not found $SERVER_LOGFILE"
  printInstallResults 1
  exit 0
}

if(!$LISTENING_ON) {
  "Error server did not start successfully"
  printInstallResults 1
  exit 0
}

# Finish server setup
printInstallResults 0
} catch {
  "Error during server setup - $($_.ToString())"
  printInstallResults 1
  exit 0
} finally {
  if($LOCK_ACQUIRED -and $LOCK_MUTEX) {
    $LOCK_MUTEX.ReleaseMutex()
  }
  if($LOCK_MUTEX) {
    $LOCK_MUTEX.Dispose()
  }
}

if($SERVER_ID) {
  while($True) {
    if(!(gps -Id $SERVER_ID)) {
      "server died, exit"
      exit 0
    }

    sleep 30
  }
}
