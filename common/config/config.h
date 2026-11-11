#pragma once

// JSON helpers. Builds on nlohmann/json (linked via the common target).

#include <nlohmann/json.hpp>
#include <string>

namespace vsres::config {

using Json = nlohmann::json;

// Parses a JSON document. Returns an empty object on parse failure (and logs via vsres::log).
Json parse(const std::string& source);

// Compact-serialize (no whitespace) for storage in the OFX `_config` String param.
std::string serialize_compact(const Json& j);

// Convenience: pretty-print for logs / debugging.
std::string serialize_pretty(const Json& j);

}  // namespace vsres::config
