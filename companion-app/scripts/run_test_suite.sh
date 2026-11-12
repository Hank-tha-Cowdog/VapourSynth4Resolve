#!/bin/bash
# Full companion test suite — CI and local. Each test file runs in its own
# node process (the suites use --test-isolation=none per file by design).
# The two real-UI suites are excluded: known Chromium sandbox startup failure
# in headless/CI environments (pre-existing, see the release history — they
# need a real GUI session; exercised manually before releases).
set -u
cd "$(dirname "$0")/.."
NODE_BIN="${NODE:-node}"
# asdf shims resolve their installs via $HOME/.asdf and fail SILENTLY with
# exit 126 when this script runs under an isolated HOME (test isolation) —
# every suite then "fails" with zero output. Prefer a real interpreter when
# PATH points at a shim. (CI: node comes from setup-node, not a shim — the
# resolved path is untouched there.)
case "$(command -v "$NODE_BIN" 2>/dev/null || true)" in
    */.asdf/shims/node)
        for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
            if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
        done
        ;;
esac
export VSRES_DISABLE_RESOLVE_DISCOVERY=1
export PYTHONDONTWRITEBYTECODE=1
export NODE_OPTIONS="${NODE_OPTIONS:-}"

# Suites that validate BUILT artifacts or a full development checkout
# (staged portable bundle, packaged app, vendored plugin dylibs, the
# development_projects sibling layout). A fresh CI checkout has none of
# these; they run in release validation and locally wherever the artifacts
# exist. Unit suites below always run.
ARTIFACT_SUITES=" __test_cst_transform.js __test_model_extractor_lifecycle.js __test_model_staged_transaction.js __test_packaged_launch.js __test_preview_failures.js __test_preview_runtime.js __test_render_worker.js __test_staging_launch.js __test_registry_filesystem.js "
artifacts_present=0
if [ -d ../build-portable/portable/VapourSynth.ofx.bundle ] \
   || [ -d ../vendor/Macos_vapoursynth_plugins ] \
   || [ -d dist/mac-arm64 ]; then
    artifacts_present=1
fi

pass=0
fail=0
failed=()

run_one() {
    local f="$1"; shift
    if [ "$artifacts_present" -eq 0 ]; then
        case "$ARTIFACT_SUITES" in
            *" $(basename "$f") "*)
                echo "SKIP $f (needs staged build artifacts / dev layout — release validation)"
                return
                ;;
        esac
    fi
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
