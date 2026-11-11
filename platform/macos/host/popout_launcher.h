#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace vsres::macos {

// One private companion exchange directory. The OFX host may optionally observe
// dev-launch process exit through child_pid() to auto-apply a saved revision on
// the main thread; the explicit Apply companion changes InstanceChanged action
// remains available and reads the same result. No timer, native preview, or
// non-main-thread callback into the host runs here. Launch submission does not
// confirm app startup or process closure.
class PopoutSession {
public:
    explicit PopoutSession(std::string config_json, bool recovery_required = false,
                           bool input_is_pending = false, std::string retained_snapshot = {});
    ~PopoutSession();
    PopoutSession(const PopoutSession&) = delete;
    PopoutSession& operator=(const PopoutSession&) = delete;
    // Single-owner, one-shot preparation beneath an explicit existing parent.
    // Does not discover/launch a companion or register a callback. Repeated
    // calls return the original result without recreating/truncating files.
    bool prepare(const std::string& exchange_parent);
    bool launch();
    enum class ResultState { Empty, Ready, AlreadyApplied, Invalid };
    ResultState read_result(std::string& result, uint64_t& revision, std::string& error,
                            std::string* retained_snapshot = nullptr) const;
    void mark_applied(uint64_t revision, std::string accepted_config);
    const std::string& status_path() const;
    // PID of the dev-launched companion process, or 0 when the launch was
    // submitted through NSWorkspace (shipped app) or never succeeded. Used by
    // the host's optional exit observer; not a liveness or ownership claim.
    int child_pid() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace vsres::macos
