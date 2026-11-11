// Node-GUID validation — the single source for "what may build a filename".
//
// A node GUID is ONLY ever [A-Za-z0-9-]{1,64}: no path separators, no dots,
// no traversal, no Unicode. Everything that constructs a sidecar, lock,
// sentinel or .vpy filename from a guid goes through this check: a corrupt or
// hostile config can never steer writes outside the nodes directory.
// Header-only + inline so both the host plugin and the unit tests share the
// exact same rule (no duplicated drift).
#pragma once

#include <cstddef>
#include <string>

namespace vsres::identity {

inline bool valid_node_guid(const std::string& g) {
    if (g.empty() || g.size() > 64) return false;
    for (char c : g) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == '-';
        if (!ok) return false;
    }
    return true;
}

}  // namespace vsres::identity