#pragma once

// Private-file and directory helpers for user data under the app-support
// tree (security review #7; hardened 2026-11-11).
//
// Guarantees for every successful write_private_file:
//   - the final path component is never followed when it is a symlink
//     (O_NOFOLLOW; the check happens on the OPENED descriptor — no TOCTOU
//     window against the open itself),
//   - only a regular file owned by this process's user is written,
//   - hardlinked targets (nlink > 1) are REFUSED — writing through them
//     would modify content reachable under another name,
//   - the file ends up 0600 even if an older build created it 0644
//     (fchmod on the same verified descriptor = safe in-place migration),
//   - truncation happens AFTER the checks, never at open time.
// A refused write returns false and, when provided, an honest short reason;
// callers treat sidecars/diagnostics as best-effort and fail closed.
//
// ensure_private_dir creates the directory 0700 when missing and verifies an
// existing one is a REAL directory (never a symlink), owned by this user,
// tightening broader modes to 0700. With check_parents=true the directory
// chain up to (and including) $HOME is verified the same way — a symlinked
// "Application Support" cannot redirect writes elsewhere.

#include <string>

namespace vsres::fs {

bool write_private_file(const std::string& path, const std::string& content,
                        std::string* out_err = nullptr);

bool ensure_private_dir(const std::string& path, bool check_parents,
                        std::string* out_err = nullptr);

}  // namespace vsres::fs
