#!/bin/bash
# Full companion test suite — CI and local. Each test file runs in its own
# node process (the suites use --test-isolation=none per file by design).
# The two real-UI suites are excluded: known Chromium sandbox startup failure
# in headless/CI environments (pre-existing, see the release history — they
# need a real GUI session; exercised manually before releases).
set -u
cd "$(dirname "$0")/.."
NODE_BIN="${NODE:-node}"
export VSRES_DISABLE_RESOLVE_DISCOVERY=1
export PYTHONDONTWRITEBYTECODE=1
export NODE_OPTIONS="${NODE_OPTIONS:-}"

pass=0
fail=0
failed=()

run_one() {
    local f="$1"; shift
    local log
    log="$(mktemp -t vsres-test.XXXXXX)"
    if "$NODE_BIN" --test --test-isolation=none "$@" "$f" >"$log" 2>&1; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        failed+=("$f")
        echo "FAIL $f"
        tail -25 "$log"
    fi
    rm -f "$log"
}

for f in electron/__test_*.js; do
    case "$(basename "$f")" in
        __test_editor_lock.js|__test_viewer_journey.js)
            echo "SKIP $f (real-UI suite, excluded)"
            continue
            ;;
    esac
    run_one "$f"
done

for f in electron/tools/__test_registry*.js; do
    run_one "$f" --test-timeout=5000
done

echo "== companion suite: $pass file(s) passed, $fail failed =="
if [ "$fail" -gt 0 ]; then
    printf '   failed: %s\n' "${failed[@]}"
    exit 1
fi
