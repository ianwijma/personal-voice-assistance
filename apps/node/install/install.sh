#!/bin/sh
# Install, update or remove a voice node of the personal voice assistant (docs/VOICE-NODES.md §7).
#
#   curl -fsSL http://assistant.lan:8787/node/install.sh | sudo sh -s -- --server http://assistant.lan:8787 --code K7QM-2XHP
#
# The copy the server serves (/node/install.sh, built by `pnpm --filter @pva/node bundle`) carries the pinned Node
# runtime and both unit templates; this source copy refuses to run. Everything it downloads is checked against a
# SHA-256 before it is used (the runtime against the pin below, the node program and boot guard against the
# server's manifest), and nothing downloaded is ever run by a shell. Running it again is safe: it keeps what is
# already right, repairs the rest and restarts the node.
#
# Options
#   --server <url>        the assistant, e.g. http://assistant.lan:8787 (remembered for later runs)
#   --code <code>         pairing code from admin (asked for when missing and the node is not paired yet)
#   --name <name>         suggested device name (default: the hostname; the name set in admin wins)
#   --tls-pin sha256:<hex> SHA-256 of the server certificate's public key (a self-signed https server)
#   --audio auto|alsa|pipewire  default auto: PipeWire when --user is given and that user's PipeWire runs, else ALSA
#   --user <name>         run as this desktop user's systemd user service (PipeWire); default: system service
#   --runtime <tarball>   use this Node tarball instead of downloading it (still checked against the pin)
#   --upgrade-runtime     only install the pinned runtime and restart the node
#   --uninstall           stop and remove the node (the device stays in admin until removed there)
#   --root <dir>          stage the files under <dir>: no root, users, packages or systemd (tests, images)
#   -h, --help
set -eu

# @@PINS@@ (scripts/bundle.mjs replaces this block with scripts/runtime.json; empty here, so this copy refuses)
NODE_VERSION=''
NODE_URL_ARM64=''
NODE_SHA256_ARM64=''
NODE_URL_X64=''
NODE_SHA256_X64=''
INSTALLER_VERSION=''
# @@END PINS@@

SYSTEM_USER=pva-node

say() { printf '%s\n' "pva-node: $*" >&2; }
die() {
	say "error: $*"
	exit 1
}
usage() { sed -n '2,/^set -eu/p' "$0" 2>/dev/null | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2 || true; }

# --- arguments ----------------------------------------------------------------------------------------------------

SERVER=''
CODE=''
NAME=''
TLS_PIN=''
AUDIO=''
RUN_AS=''
RUNTIME_TARBALL=''
MODE=install
ROOT=''

need_value() { [ "$2" -ge 2 ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
	case $1 in
	--server) need_value "$1" $#; SERVER=$2; shift 2 ;;
	--server=*) SERVER=${1#*=}; shift ;;
	--code) need_value "$1" $#; CODE=$2; shift 2 ;;
	--code=*) CODE=${1#*=}; shift ;;
	--name) need_value "$1" $#; NAME=$2; shift 2 ;;
	--name=*) NAME=${1#*=}; shift ;;
	--tls-pin) need_value "$1" $#; TLS_PIN=$2; shift 2 ;;
	--tls-pin=*) TLS_PIN=${1#*=}; shift ;;
	--audio) need_value "$1" $#; AUDIO=$2; shift 2 ;;
	--audio=*) AUDIO=${1#*=}; shift ;;
	--user) need_value "$1" $#; RUN_AS=$2; shift 2 ;;
	--user=*) RUN_AS=${1#*=}; shift ;;
	--runtime) need_value "$1" $#; RUNTIME_TARBALL=$2; shift 2 ;;
	--runtime=*) RUNTIME_TARBALL=${1#*=}; shift ;;
	--upgrade-runtime) MODE=upgrade-runtime; shift ;;
	--uninstall) MODE=uninstall; shift ;;
	--root) need_value "$1" $#; ROOT=$2; shift 2 ;;
	--root=*) ROOT=${1#*=}; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown option $1 (--help lists them)" ;;
	esac
done

# --- where things go ----------------------------------------------------------------------------------------------

STAGE=0
if [ -n "$ROOT" ]; then
	STAGE=1
	mkdir -p "$ROOT"
	ROOT=$(cd "$ROOT" && pwd)
fi
OPT=$ROOT/opt/pva-node
RUNTIME_DIR=$OPT/runtime
RELEASES=$OPT/releases
BOOT=$OPT/pva-node-boot.mjs
ETC=$ROOT/etc/pva-node
CONFIG=$ETC/node.json
INSTALL_ENV=$ETC/install.env
VAR=$ROOT/var/lib/pva-node
SYSTEM_UNIT=$ROOT/etc/systemd/system/pva-node.service

# A command that changes the system outside the staged files: run it, or (with --root) only record it.
act() {
	if [ "$STAGE" = 1 ]; then
		printf '%s\n' "$*" >>"$ROOT/actions.log"
	else
		"$@"
	fi
}

have() { command -v "$1" >/dev/null 2>&1; }

sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }

TMP=''
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM

# install.env: what an earlier run chose (KEY=value lines, written by this script, never sourced).
env_get() { if [ -f "$INSTALL_ENV" ]; then sed -n "s/^$1=//p" "$INSTALL_ENV" | tail -n 1; fi; }

# --- checks -------------------------------------------------------------------------------------------------------

preflight() {
	[ -n "$NODE_VERSION" ] || die "this is the source copy of install.sh; use the one the assistant serves at /node/install.sh (built by: pnpm --filter @pva/node bundle)"
	[ "$(uname -s)" = Linux ] || die "voice nodes run on Linux only"
	if [ "$STAGE" = 0 ]; then
		[ "$(id -u)" = 0 ] || die "run as root (sudo sh install.sh ...)"
		[ -d /run/systemd/system ] || die "this box does not run systemd"
	fi
	case $(uname -m) in
	aarch64 | arm64) ARCH=arm64; NODE_URL=$NODE_URL_ARM64; NODE_SHA256=$NODE_SHA256_ARM64 ;;
	x86_64 | amd64) ARCH=x64; NODE_URL=$NODE_URL_X64; NODE_SHA256=$NODE_SHA256_X64 ;;
	armv7l | armv6l | armhf) die "32-bit ARM is not supported (yet); install the 64-bit Raspberry Pi OS" ;;
	*) die "unsupported processor $(uname -m) (arm64 and x86-64 are supported)" ;;
	esac
	for tool in curl tar gzip sha256sum mktemp sed cut; do
		have "$tool" || die "$tool is missing (apt-get install curl tar gzip coreutils sed)"
	done
	TMP=$(mktemp -d)
}

validate_server() {
	SERVER=${SERVER%/}
	printf '%s' "$SERVER" | grep -Eq '^https?://[A-Za-z0-9._~:@%+-]+(:[0-9]+)?(/[A-Za-z0-9._~%+/-]*)?$' ||
		die "--server must be an http:// or https:// URL like http://assistant.lan:8787, not '$SERVER'"
	if [ -n "$TLS_PIN" ]; then
		printf '%s' "$TLS_PIN" | grep -Eq '^sha256:[0-9a-fA-F]{64}$' || die "--tls-pin must be sha256:<64 hex digits>"
	fi
}

# --- the runtime --------------------------------------------------------------------------------------------------

install_runtime() {
	runtime_name=node-v$NODE_VERSION-linux-$ARCH
	runtime_path=$RUNTIME_DIR/$runtime_name
	mkdir -p "$RUNTIME_DIR"
	if [ -x "$runtime_path/bin/node" ] && [ "$(cat "$runtime_path/.sha256" 2>/dev/null || true)" = "$NODE_SHA256" ]; then
		say "Node $NODE_VERSION is installed"
	else
		if [ -n "$RUNTIME_TARBALL" ]; then
			[ -f "$RUNTIME_TARBALL" ] || die "--runtime $RUNTIME_TARBALL: no such file"
			tarball=$RUNTIME_TARBALL
		else
			say "downloading Node $NODE_VERSION ($ARCH) from nodejs.org"
			tarball=$TMP/node.tar.gz
			curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$tarball" "$NODE_URL" || die "cannot download $NODE_URL (no internet? use --runtime <tarball>)"
		fi
		actual=$(sha256_of "$tarball")
		[ "$actual" = "$NODE_SHA256" ] || die "the Node tarball has SHA-256 $actual, expected $NODE_SHA256 ($runtime_name.tar.gz); nothing was installed"
		staging=$RUNTIME_DIR/.staging.$$
		rm -rf "$staging"
		mkdir -p "$staging"
		tar -xzf "$tarball" -C "$staging" --no-same-owner
		[ -x "$staging/$runtime_name/bin/node" ] || die "the tarball does not contain $runtime_name/bin/node"
		# C headers and man pages are not needed to run (65 MB of a Pi's SD card).
		rm -rf "$staging/$runtime_name/include" "$staging/$runtime_name/share"
		rm -rf "$runtime_path"
		mv "$staging/$runtime_name" "$runtime_path"
		rmdir "$staging"
		printf '%s\n' "$NODE_SHA256" >"$runtime_path/.sha256"
		say "installed Node $NODE_VERSION"
	fi
	ln -s "$runtime_name" "$RUNTIME_DIR/.current.tmp.$$"
	mv -T "$RUNTIME_DIR/.current.tmp.$$" "$RUNTIME_DIR/current"
	for old in "$RUNTIME_DIR"/node-v*; do
		if [ -d "$old" ] && [ "$old" != "$runtime_path" ]; then rm -rf "$old"; fi
	done
	NODE=$RUNTIME_DIR/current/bin/node
	"$NODE" --version >/dev/null 2>&1 || die "the installed Node does not run on this box"
}

# --- downloads from the server ------------------------------------------------------------------------------------

# fetch <url> <file>: from the assistant, honouring --tls-pin (curl's public-key pin; -k only skips the CA check,
# the pin is still enforced).
fetch() {
	if [ -n "$TLS_PIN" ]; then
		pin_b64=$("$NODE" -e 'process.stdout.write(Buffer.from(process.argv[1].slice(7), "hex").toString("base64"))' "$TLS_PIN")
		curl -fsS --max-time 300 -k --pinnedpubkey "sha256//$pin_b64" -o "$2" "$1"
	else
		curl -fsS --max-time 300 -o "$2" "$1"
	fi
}

# fetch_verified <name> <sha256> <bytes> <file>: a file of the manifest, refused unless length and hash match.
fetch_verified() {
	fetch "$SERVER/node/$1" "$4" || die "cannot download $SERVER/node/$1"
	got_bytes=$(wc -c <"$4" | tr -d ' ')
	[ "$got_bytes" = "$3" ] || die "$1 has $got_bytes bytes, the manifest says $3; nothing was changed"
	got_sha=$(sha256_of "$4")
	[ "$got_sha" = "$2" ] || die "$1 has SHA-256 $got_sha, the manifest says $2; nothing was changed"
}

read_manifest() {
	fetch "$SERVER/node/manifest.json" "$TMP/manifest.json" || die "cannot fetch $SERVER/node/manifest.json (is the server reachable from here, and has it built the node bundle?)"
	# Parsed by the runtime just installed; every value is checked before the shell sees it.
	"$NODE" -e '
		const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
		const file = (a) => a && typeof a.path === "string" && /^[A-Za-z0-9._-]+$/.test(a.path) && !a.path.startsWith(".") &&
			/^[0-9a-f]{64}$/.test(a.sha256) && Number.isInteger(a.bytes) && a.bytes > 0
		if (m.format !== 1 || !file(m.bundle) || !file(m.boot) || typeof m.version !== "string" || !/^[\w.+-]{1,64}$/.test(m.version)) {
			console.error("not a voice-node manifest"); process.exit(1)
		}
		const rt = m.runtime && typeof m.runtime.version === "string" && /^[\w.]+$/.test(m.runtime.version) ? m.runtime.version : ""
		console.log([m.bundle.path, m.bundle.sha256, m.bundle.bytes, m.boot.path, m.boot.sha256, m.boot.bytes, m.version, rt].join("\n"))
	' "$TMP/manifest.json" >"$TMP/manifest.txt" || die "$SERVER/node/manifest.json is not a voice-node manifest"
	BUNDLE_PATH=$(sed -n 1p "$TMP/manifest.txt")
	BUNDLE_SHA=$(sed -n 2p "$TMP/manifest.txt")
	BUNDLE_BYTES=$(sed -n 3p "$TMP/manifest.txt")
	BOOT_PATH=$(sed -n 4p "$TMP/manifest.txt")
	BOOT_SHA=$(sed -n 5p "$TMP/manifest.txt")
	BOOT_BYTES=$(sed -n 6p "$TMP/manifest.txt")
	SERVER_VERSION=$(sed -n 7p "$TMP/manifest.txt")
	manifest_runtime=$(sed -n 8p "$TMP/manifest.txt")
	[ "$manifest_runtime" = "$NODE_VERSION" ] ||
		die "this install.sh pins Node $NODE_VERSION but the server's manifest pins Node $manifest_runtime: download install.sh from the server again"
}

install_boot() {
	if [ -f "$BOOT" ] && [ "$(sha256_of "$BOOT")" = "$BOOT_SHA" ]; then return; fi
	fetch_verified "$BOOT_PATH" "$BOOT_SHA" "$BOOT_BYTES" "$TMP/boot.mjs"
	cp "$TMP/boot.mjs" "$OPT/.boot.tmp.$$"
	chmod 0644 "$OPT/.boot.tmp.$$"
	mv "$OPT/.boot.tmp.$$" "$BOOT"
	say "installed the boot guard"
}

install_release() {
	release=$RELEASES/$BUNDLE_SHA
	if [ -f "$release/pva-node.mjs" ] && [ "$(sha256_of "$release/pva-node.mjs")" = "$BUNDLE_SHA" ]; then
		say "release $SERVER_VERSION is installed"
	else
		fetch_verified "$BUNDLE_PATH" "$BUNDLE_SHA" "$BUNDLE_BYTES" "$TMP/pva-node.mjs"
		mkdir -p "$release"
		cp "$TMP/pva-node.mjs" "$release/.pva-node.mjs.tmp"
		chmod 0644 "$release/.pva-node.mjs.tmp"
		mv "$release/.pva-node.mjs.tmp" "$release/pva-node.mjs"
		say "installed release $SERVER_VERSION ($(printf '%s' "$BUNDLE_SHA" | cut -c 1-12))"
	fi
	old=$(readlink "$RELEASES/current" 2>/dev/null || true)
	if [ -n "$old" ] && [ "$old" != "$BUNDLE_SHA" ] && [ -d "$RELEASES/$old" ]; then
		ln -s "$old" "$RELEASES/.previous.tmp.$$"
		mv -T "$RELEASES/.previous.tmp.$$" "$RELEASES/previous"
	fi
	ln -s "$BUNDLE_SHA" "$RELEASES/.current.tmp.$$"
	mv -T "$RELEASES/.current.tmp.$$" "$RELEASES/current"
	# The installer's choice is trusted: forget probation, rollbacks and refused releases of earlier runs.
	rm -f "$RELEASES/state.json"
	# Release directories other than current and previous (64 hex digits; never the links themselves) go.
	keep_previous=$(readlink "$RELEASES/previous" 2>/dev/null || true)
	for dir in "$RELEASES"/*; do
		name=${dir##*/}
		[ ! -L "$dir" ] && [ -d "$dir" ] || continue
		printf '%s' "$name" | grep -Eq '^[0-9a-f]{64}$' || continue
		if [ "$name" != "$BUNDLE_SHA" ] && [ "$name" != "$keep_previous" ]; then rm -rf "$dir"; fi
	done
	if [ -n "$keep_previous" ] && [ ! -d "$RELEASES/$keep_previous" ]; then rm -f "$RELEASES/previous"; fi
	"$NODE" "$RELEASES/current/pva-node.mjs" version >"$TMP/version.json" 2>"$TMP/version.err" ||
		die "the node program does not start: $(cat "$TMP/version.err")"
	grep -q "\"bundleSha256\":\"$BUNDLE_SHA\"" "$TMP/version.json" || die "the installed release does not report its own hash: $(cat "$TMP/version.json")"
}

# --- audio --------------------------------------------------------------------------------------------------------

user_pipewire_active() { systemctl --user -M "$1@" is-active --quiet pipewire.service 2>/dev/null; }

choose_variant() {
	if [ -n "$RUN_AS" ]; then
		[ "$RUN_AS" != root ] || die "--user root: the node must not run as root"
		printf '%s' "$RUN_AS" | grep -Eq '^[a-z_][a-z0-9_-]*$' || die "--user $RUN_AS is not a user name"
		[ "$STAGE" = 1 ] || id -u "$RUN_AS" >/dev/null 2>&1 || die "no user $RUN_AS on this box"
	fi
	case ${AUDIO:-auto} in
	auto)
		if [ -n "$RUN_AS" ] && [ "$STAGE" = 0 ] && user_pipewire_active "$RUN_AS"; then
			AUDIO=pipewire
		else
			if [ -n "$RUN_AS" ]; then say "$RUN_AS has no running PipeWire; using ALSA as a system service instead"; fi
			AUDIO=alsa
			RUN_AS=''
		fi
		;;
	alsa)
		[ -z "$RUN_AS" ] || die "ALSA runs as the system service; drop --user (or use --audio pipewire)"
		;;
	pipewire)
		[ -n "$RUN_AS" ] || die "PipeWire runs per user: pass --user <desktop user> with --audio pipewire"
		;;
	*) die "--audio must be auto, alsa or pipewire" ;;
	esac
	if [ -n "$RUN_AS" ]; then
		VARIANT=user
		RUN_USER=$RUN_AS
		if [ "$STAGE" = 1 ]; then RUN_HOME=$ROOT/home/$RUN_AS; else RUN_HOME=$(getent passwd "$RUN_AS" | cut -d : -f 6); fi
		[ -n "$RUN_HOME" ] || die "cannot find the home directory of $RUN_AS"
		USER_UNIT=$RUN_HOME/.config/systemd/user/pva-node.service
	else
		VARIANT=system
		RUN_USER=$SYSTEM_USER
	fi
}

install_audio_packages() {
	if [ "$AUDIO" = alsa ]; then tools='arecord aplay' package=alsa-utils; else tools='pw-record pw-cat' package=pipewire-bin; fi
	missing=0
	for tool in $tools; do have "$tool" || missing=1; done
	[ "$missing" = 1 ] || return 0
	if [ "$STAGE" = 1 ]; then
		say "would install $package (not on this machine's PATH)"
		act apt-get install -y --no-install-recommends "$package"
	elif have apt-get; then
		say "installing $package"
		DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package" >/dev/null ||
			die "cannot install $package (apt-get update first?)"
	else
		die "$tools missing: install $package"
	fi
}

# --- the user and the files ---------------------------------------------------------------------------------------

ensure_user() {
	[ "$VARIANT" = system ] || return 0
	if [ "$STAGE" = 0 ] && id -u "$SYSTEM_USER" >/dev/null 2>&1; then
		:
	else
		have useradd || [ "$STAGE" = 1 ] || die "useradd is missing"
		act useradd --system --user-group --home-dir /var/lib/pva-node --no-create-home --shell /usr/sbin/nologin "$SYSTEM_USER"
	fi
	act usermod -a -G audio "$SYSTEM_USER"
}

run_group() { if [ "$STAGE" = 1 ]; then printf '%s' "$RUN_USER"; else id -gn "$RUN_USER"; fi; }

make_dirs() {
	mkdir -p "$OPT" "$RUNTIME_DIR" "$RELEASES" "$ETC" "$VAR"
	chmod 0755 "$OPT" "$RUNTIME_DIR" "$RELEASES" "$ETC"
	chmod 0700 "$VAR"
}

own_files() {
	group=$(run_group)
	act chown -R root:root "$RUNTIME_DIR"
	act chown root:root "$OPT" "$BOOT" "$ETC"
	act chown -R "$RUN_USER:$group" "$RELEASES" "$VAR"
	act chown "$RUN_USER:$group" "$CONFIG"
	chmod 0600 "$CONFIG"
}

write_config() {
	# The server refuses a node that was not paired, so a config comes from pairing and from nothing else.
	if [ -n "$CODE" ]; then
		set -- pair --server "$SERVER" --code "$CODE" --config "$CONFIG"
	elif [ -f "$CONFIG" ] && grep -q '"credential"' "$CONFIG"; then
		say "keeping $CONFIG (pass --code to pair again)"
		return 0
	else
		# No config, or one from before pairing (no credential): the server would refuse it.
		[ -r /dev/tty ] && [ -w /dev/tty ] || die "this node is not paired: pass --code <code> (Admin › Devices › Add voice node)"
		printf 'Pairing code (Admin › Devices › Add voice node): ' >/dev/tty
		read -r CODE </dev/tty || die "no pairing code"
		[ -n "$CODE" ] || die "no pairing code"
		set -- pair --server "$SERVER" --code "$CODE" --config "$CONFIG"
	fi
	if [ -n "$TLS_PIN" ]; then set -- "$@" --tls-pin "$TLS_PIN"; fi
	if [ -n "$NAME" ]; then set -- "$@" --name "$NAME"; fi
	"$NODE" "$RELEASES/current/pva-node.mjs" "$@" || die "could not write $CONFIG"
}

write_install_env() {
	{
		printf '# Written by install.sh %s; read by later runs (never sourced).\n' "$INSTALLER_VERSION"
		printf 'VARIANT=%s\nRUN_USER=%s\nAUDIO=%s\nSERVER=%s\nTLS_PIN=%s\n' "$VARIANT" "$RUN_USER" "$AUDIO" "$SERVER" "$TLS_PIN"
	} >"$INSTALL_ENV.tmp"
	chmod 0644 "$INSTALL_ENV.tmp"
	mv "$INSTALL_ENV.tmp" "$INSTALL_ENV"
}

# --- the unit -----------------------------------------------------------------------------------------------------

system_unit_template() {
	cat <<'PVA_UNIT_END'
@@SYSTEM_UNIT@@
PVA_UNIT_END
}

user_unit_template() {
	cat <<'PVA_UNIT_END'
@@USER_UNIT@@
PVA_UNIT_END
}

user_systemctl() { act systemctl --user -M "$RUN_USER@" "$@"; }

stop_node() {
	[ "$STAGE" = 0 ] || return 0
	systemctl stop pva-node.service 2>/dev/null || true
	previous_user=$(env_get RUN_USER)
	if [ "$(env_get VARIANT)" = user ] && [ -n "$previous_user" ]; then
		systemctl --user -M "$previous_user@" stop pva-node.service 2>/dev/null || true
	fi
}

install_unit() {
	if [ "$VARIANT" = system ]; then
		mkdir -p "${SYSTEM_UNIT%/*}"
		system_unit_template | sed "s/@AUDIO@/$AUDIO/g" >"$SYSTEM_UNIT.tmp"
		chmod 0644 "$SYSTEM_UNIT.tmp"
		mv "$SYSTEM_UNIT.tmp" "$SYSTEM_UNIT"
		act systemctl daemon-reload
		act systemctl enable pva-node.service
		act systemctl restart pva-node.service
	else
		# A system unit of an earlier run would fight over the audio and the config.
		if [ -f "$SYSTEM_UNIT" ]; then
			act systemctl disable --now pva-node.service
			rm -f "$SYSTEM_UNIT"
			act systemctl daemon-reload
		fi
		mkdir -p "${USER_UNIT%/*}"
		user_unit_template | sed -e "s/@AUDIO@/$AUDIO/g" -e "s/@USER@/$RUN_USER/g" >"$USER_UNIT.tmp"
		chmod 0644 "$USER_UNIT.tmp"
		mv "$USER_UNIT.tmp" "$USER_UNIT"
		act chown -R "$RUN_USER:$(run_group)" "$RUN_HOME/.config/systemd"
		act loginctl enable-linger "$RUN_USER"
		user_systemctl daemon-reload
		user_systemctl enable pva-node.service
		user_systemctl restart pva-node.service
	fi
}

report() {
	if [ "$STAGE" = 1 ]; then
		say "staged under $ROOT (system changes listed in $ROOT/actions.log)"
		return 0
	fi
	sleep 3
	if [ "$VARIANT" = system ]; then
		if systemctl is-active --quiet pva-node.service; then say "the node is running: journalctl -u pva-node -f"; else
			say "the node did not stay up; see: journalctl -u pva-node -e"
			exit 1
		fi
	else
		if systemctl --user -M "$RUN_USER@" is-active --quiet pva-node.service; then say "the node is running: journalctl --user -M $RUN_USER@ -u pva-node -f"; else
			say "the node did not stay up; see: journalctl --user -M $RUN_USER@ -u pva-node -e"
			exit 1
		fi
	fi
}

# --- modes --------------------------------------------------------------------------------------------------------

do_install() {
	preflight
	[ -n "$SERVER" ] || SERVER=$(env_get SERVER)
	[ -n "$TLS_PIN" ] || TLS_PIN=$(env_get TLS_PIN)
	[ -n "$AUDIO" ] || AUDIO=$(env_get AUDIO)
	if [ -z "$RUN_AS" ] && [ "$(env_get VARIANT)" = user ]; then RUN_AS=$(env_get RUN_USER); fi
	if [ -z "$SERVER" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
		printf 'Assistant URL (e.g. http://assistant.lan:8787): ' >/dev/tty
		read -r SERVER </dev/tty || true
	fi
	[ -n "$SERVER" ] || die "pass --server <url of the assistant>"
	validate_server
	choose_variant
	say "installing a voice node for $SERVER ($AUDIO, $VARIANT service as $RUN_USER, $ARCH)"
	install_audio_packages
	ensure_user
	make_dirs
	install_runtime
	read_manifest
	stop_node
	install_boot
	install_release
	write_config
	own_files
	write_install_env
	install_unit
	report
}

do_upgrade_runtime() {
	preflight
	[ -f "$INSTALL_ENV" ] || die "no voice node is installed here (no $INSTALL_ENV)"
	VARIANT=$(env_get VARIANT)
	RUN_USER=$(env_get RUN_USER)
	install_runtime
	act chown -R root:root "$RUNTIME_DIR"
	if [ "$VARIANT" = user ]; then user_systemctl restart pva-node.service; else act systemctl restart pva-node.service; fi
	say "the node runs on Node $NODE_VERSION now"
}

do_uninstall() {
	if [ "$STAGE" = 0 ]; then [ "$(id -u)" = 0 ] || die "run as root"; fi
	variant=$(env_get VARIANT)
	user=$(env_get RUN_USER)
	if [ -f "$SYSTEM_UNIT" ]; then
		act systemctl disable --now pva-node.service
		rm -f "$SYSTEM_UNIT"
		act systemctl daemon-reload
	fi
	if [ "$variant" = user ] && [ -n "$user" ]; then
		if [ "$STAGE" = 1 ]; then home=$ROOT/home/$user; else home=$(getent passwd "$user" | cut -d : -f 6); fi
		act systemctl --user -M "$user@" disable --now pva-node.service
		if [ -n "$home" ]; then rm -f "$home/.config/systemd/user/pva-node.service"; fi
		act systemctl --user -M "$user@" daemon-reload
		say "lingering stays on for $user (loginctl disable-linger $user turns it off)"
	fi
	rm -rf "$OPT" "$ETC" "$VAR"
	if [ "$STAGE" = 1 ] || id -u "$SYSTEM_USER" >/dev/null 2>&1; then act userdel "$SYSTEM_USER"; fi
	say "removed. Remove the device in admin too (Admin › Devices), if you have not."
}

case $MODE in
install) do_install ;;
upgrade-runtime) do_upgrade_runtime ;;
uninstall) do_uninstall ;;
esac
