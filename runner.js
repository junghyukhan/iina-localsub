// Arguments are passed separately; no media paths or preferences become shell code.
module.exports = `
directory=$1
binary=$2
input=$3
language=$4
parent=\${LOCALSUB_OWNER_PID:-$PPID}
worker=
watcher=

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ -n "$watcher" ]; then
        kill "$watcher" 2>/dev/null || :
        wait "$watcher" 2>/dev/null || :
    fi
    if [ "$status" -ne 0 ]; then
        /bin/rm -rf -- "$directory"
    fi
    exit "$status"
}

stop() {
    if [ -n "$worker" ]; then
        kill -TERM "$worker" 2>/dev/null || :
        wait "$worker" 2>/dev/null || :
    fi
    exit 143
}

[ -d "$directory" ] && [ "$directory" != / ] || exit 2
trap cleanup EXIT
trap stop INT TERM
[ ! -e "$directory/cancel" ] || exit 143

set -- --format srt --output "$directory/subtitles.srt"
if [ -n "$language" ]; then
    set -- "$@" --language "$language"
fi
"$binary" "$@" -- "$input" >/dev/null &
worker=$!

(
    while kill -0 "$worker" 2>/dev/null; do
        if [ -e "$directory/cancel" ] || ! kill -0 "$parent" 2>/dev/null; then
            kill -TERM "$worker" 2>/dev/null || :
            attempts=0
            while [ "$attempts" -lt 10 ] && kill -0 "$worker" 2>/dev/null; do
                /bin/sleep 1
                attempts=$((attempts + 1))
            done
            kill -KILL "$worker" 2>/dev/null || :
            exit
        fi
        /bin/sleep 1
    done
) >/dev/null 2>&1 &
watcher=$!
wait "$worker"
status=$?
if [ -e "$directory/cancel" ]; then
    exit 143
fi
exit "$status"
`;
