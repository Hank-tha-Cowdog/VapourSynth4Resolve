// Companion file exchange is pulled only from an explicit OFX host action.
// No asynchronous plugin-code callback or in-process preview is started here.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstdio>
#include <vector>
#include <mutex>
#include <cmath>
#include <limits>
#include <fcntl.h>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>

#include "popout_launcher.h"
#include "../../../common/config/config.h"
#include "../../../common/logging/log.h"

namespace vsres::macos {

namespace {

NSString* read_dev_companion_path() {
    NSArray<NSString*>* dirs = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory,
                                                                   NSUserDomainMask, YES);
    NSString* base = dirs.firstObject;
    if (!base) return nil;
    NSString* dir = [base stringByAppendingPathComponent:@"VapourSynth-OFX"];
    NSString* path_file = [dir stringByAppendingPathComponent:@"dev-companion-path.txt"];
    NSError* err = nil;
    NSString* contents = [NSString stringWithContentsOfFile:path_file
                                                   encoding:NSUTF8StringEncoding
                                                      error:&err];
    if (err || !contents) return nil;
    NSString* trimmed = [contents stringByTrimmingCharactersInSet:
                            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    BOOL is_dir = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:trimmed isDirectory:&is_dir] && is_dir) {
        return trimmed;
    }
    return nil;
}

bool create_file(const std::string& path, const std::string& contents) {
    const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    size_t offset = 0;
    bool ok = true;
    while (offset < contents.size()) {
        const ssize_t n = write(fd, contents.data() + offset, contents.size() - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ok = false; break; }
        offset += static_cast<size_t>(n);
    }
    if (close(fd) != 0) ok = false;
    if (!ok) unlink(path.c_str());  // only after our O_EXCL creation succeeded
    return ok;
}

}  // namespace

struct PopoutSession::Impl {
    std::string directory;
    std::string config_path;
    std::string result_path;
    std::string status_path;
    std::string config_json;
    std::string session_id;
    bool recovery_required = false;
    bool input_is_pending = false;
    std::string retained_snapshot;
    std::string retained_snapshot_path;
    bool preparation_attempted = false;
    bool files_prepared = false;
    bool launch_attempted = false;
    int child_pid = 0;
    std::atomic<uint64_t> applied_revision{0};
    mutable std::mutex applied_mutex;
    std::string applied_config;

    ~Impl() {
        // Fixed owned files only; never recurse through a companion-created entry.
        if (!config_path.empty()) unlink(config_path.c_str());
        if (!result_path.empty()) unlink(result_path.c_str());
        if (!status_path.empty()) unlink(status_path.c_str());
        if (!retained_snapshot_path.empty()) unlink(retained_snapshot_path.c_str());
        if (!directory.empty()) rmdir(directory.c_str());
    }

    bool prepare_files(const std::string& parent) {
        std::string pattern = parent + "/vsresolve-session-XXXXXX";
        std::vector<char> name(pattern.begin(), pattern.end());
        name.push_back('\0');
        char* created = mkdtemp(name.data());  // atomic exclusive directory, mode0700
        if (!created) return false;
        directory = created;
        session_id = directory.substr(directory.find_last_of('/') + 1);
        config_path = directory + "/config.json";
        result_path = directory + "/result.json";
        status_path = directory + "/status.json";
        if (!create_file(config_path, config_json) || !create_file(result_path, "") ||
            !create_file(status_path, R"({"state":"idle","error":null,"scriptPreview":"","stepCount":0,"timestampMs":0})")) {
            log::error("popout", "failed to prepare private companion exchange files");
            return false;
        }
        if (!retained_snapshot.empty()) {
            retained_snapshot_path = directory + "/prior-result.raw.json";
            if (!create_file(retained_snapshot_path, retained_snapshot)) return false;
            std::string{}.swap(retained_snapshot);
        }
        return true;
    }

    ResultState read_result(std::string& result, uint64_t& revision, std::string& error, std::string* snapshot) const {
        result.clear();
        if (snapshot) snapshot->clear();
        revision = 0;
        error.clear();
        const int fd = open(result_path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
        if (fd < 0) { error = "Companion result is unavailable. Save edits in the companion first."; return ResultState::Invalid; }
        struct ResultFd {
            int value;
            ~ResultFd() { if (value >= 0) close(value); }
        } owned{fd};
        struct stat before{}, after{};
        // A bounded IPC intake refusal, not a native-work memory estimate.
        constexpr off_t kMaxResultBytes = 8 * 1024 * 1024;
        const bool regular = fstat(fd, &before) == 0 && S_ISREG(before.st_mode);
        if (regular && before.st_size == 0) return ResultState::Empty;
        bool ok = regular && before.st_size > 0 && before.st_size <= kMaxResultBytes;
        if (ok) {
            result.resize(static_cast<size_t>(before.st_size));
            size_t offset = 0;
            while (offset < result.size()) {
                const ssize_t n = read(fd, result.data() + offset, result.size() - offset);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) { ok = false; break; }
                offset += static_cast<size_t>(n);
            }
            char extra;
            ok = ok && read(fd, &extra, 1) == 0 && fstat(fd, &after) == 0 &&
                 before.st_size == after.st_size &&
                 before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
                 before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
        }
        if (close(fd) != 0) ok = false;
        owned.value = -1;
        // Capture only a complete stable bounded regular-file body. Oversize,
        // nonregular, nofollow/open/read failure has no fabricated snapshot.
        if (ok && snapshot) *snapshot = result;
        if (ok) {
            const auto j = config::Json::parse(result, nullptr, false);
            ok = j.is_object() && j.contains("sessionId") && j["sessionId"].is_string() &&
                 j["sessionId"].get<std::string>() == session_id &&
                 j.contains("revision") && j["revision"].is_number_unsigned() &&
                 j["revision"].get<uint64_t>() > 0 &&
                 j["revision"].get<uint64_t>() <= 9007199254740991ULL &&
                 j.contains("config") && j["config"].is_object() &&
                 j["config"].contains("chain") && j["config"]["chain"].is_array();
            if (ok) {
                revision = j["revision"].get<uint64_t>();
                const auto& cfg = j["config"];
                const auto integer = [](const config::Json& v) {
                    return v.is_number_integer() &&
                        v.get<double>() >= std::numeric_limits<int>::min() &&
                        v.get<double>() <= std::numeric_limits<int>::max();
                };
                // Minimum known transport shapes only, not filter-parameter,
                // script-safety, complete schema or credential validation.
                ok = (!cfg.contains("schemaVersion") || integer(cfg["schemaVersion"])) &&
                     (!cfg.contains("nodeId") || cfg["nodeId"].is_string()) &&
                     (!cfg.contains("manualOrder") || cfg["manualOrder"].is_boolean()) &&
                     (!cfg.contains("mix") || (cfg["mix"].is_number() &&
                       std::isfinite(cfg["mix"].get<double>()) &&
                       std::abs(cfg["mix"].get<double>()) <= std::numeric_limits<float>::max()));
                if (cfg.contains("colorManagement")) {
                    const auto& cm = cfg["colorManagement"];
                    ok = ok && cm.is_object();
                    if (cm.is_object()) for (const char* key : {"inputColorSpace", "inputGamma", "outputColorSpace", "outputGamma", "ocioConfig"})
                        ok = ok && (!cm.contains(key) || cm[key].is_string());
                }
                for (const auto& step : cfg["chain"]) {
                    if (!step.is_object()) { ok = false; break; }
                    ok = ok && (!step.contains("params") || step["params"].is_object());
                    for (const char* key : {"id", "type"}) ok = ok && (!step.contains(key) || step[key].is_string());
                    for (const char* key : {"enabled", "approved"}) ok = ok && (!step.contains(key) || step[key].is_boolean());
                    for (const char* key : {"stage", "version"}) ok = ok && (!step.contains(key) || integer(step[key]));
                }
                if (ok) {
                    result = cfg.dump();
                    // Canonical number/string expansion can exceed input size.
                    // Keep retained accepted-body reserve truthful too.
                    ok = result.size() <= static_cast<size_t>(kMaxResultBytes);
                }
            }
        }
        if (!ok) {
            result.clear();
            error = "No new complete configuration matches this session (at most 8 MiB). Save edits again, then Apply companion changes.";
        }
        if (!ok) return ResultState::Invalid;
        std::lock_guard<std::mutex> lock(applied_mutex);
        const uint64_t accepted = applied_revision.load();
        if (revision < accepted || (revision == accepted && result != applied_config)) {
            error = "This saved revision is stale or conflicts with the accepted payload. Reopen Configure to repair it; the pending file is retained.";
            return ResultState::Invalid;
        }
        return revision == accepted ? ResultState::AlreadyApplied : ResultState::Ready;
    }

    bool launch_shipped() {
        NSURL* app_url = [NSURL fileURLWithPath:@"/Applications/VapourSynth Companion.app"];
        if (![[NSFileManager defaultManager] fileExistsAtPath:[app_url path]]) return false;

        NSWorkspaceOpenConfiguration* cfg = [NSWorkspaceOpenConfiguration configuration];
        cfg.activates = YES;
        // AppKit arguments apply only to a NEW instance. This requests one;
        // launch/startup/process closure still require actual qualification.
        cfg.createsNewApplicationInstance = YES;
        cfg.arguments = @[
            [NSString stringWithFormat:@"--config-path=%s", config_path.c_str()],
            [NSString stringWithFormat:@"--result-path=%s", result_path.c_str()],
            [NSString stringWithFormat:@"--status-path=%s", status_path.c_str()],
            @"--host-apply-mode=manual",
            [NSString stringWithFormat:@"--host-recovery-required=%d", recovery_required ? 1 : 0],
            [NSString stringWithFormat:@"--host-config-origin=%s", input_is_pending ? "pending" : "host"],
            [NSString stringWithFormat:@"--host-applied-revision=%llu", static_cast<unsigned long long>(applied_revision.load())],
            [NSString stringWithFormat:@"--host-session-id=%s", session_id.c_str()],
        ];

        // The optional completion block could execute plugin-module code after
        // OFX unload. Submit without a callback; this is not launch confirmation.
        [[NSWorkspace sharedWorkspace] openApplicationAtURL:app_url
                                              configuration:cfg
                                          completionHandler:nil];
        log::info("popout", "Companion (shipped) launch request submitted; outcome unconfirmed");
        return true;
    }

    bool launch_dev(NSString* companion_dir) {
        NSString* electron_bin = [companion_dir stringByAppendingPathComponent:
            @"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"];
        if (![[NSFileManager defaultManager] fileExistsAtPath:electron_bin]) {
            log::error("popout", std::string("Electron binary not found at ")
                                    + [electron_bin UTF8String]
                                    + " — did you run `npm install` in companion-app/?");
            return false;
        }

        NSTask* task = [[NSTask alloc] init];
        task.launchPath = electron_bin;
        task.arguments = @[
            companion_dir,
            [NSString stringWithFormat:@"--config-path=%s", config_path.c_str()],
            [NSString stringWithFormat:@"--result-path=%s", result_path.c_str()],
            [NSString stringWithFormat:@"--status-path=%s", status_path.c_str()],
            @"--host-apply-mode=manual",
            [NSString stringWithFormat:@"--host-recovery-required=%d", recovery_required ? 1 : 0],
            [NSString stringWithFormat:@"--host-config-origin=%s", input_is_pending ? "pending" : "host"],
            [NSString stringWithFormat:@"--host-applied-revision=%llu", static_cast<unsigned long long>(applied_revision.load())],
            [NSString stringWithFormat:@"--host-session-id=%s", session_id.c_str()],
        ];

        NSMutableDictionary* env = [[[NSProcessInfo processInfo] environment] mutableCopy];
        env[@"VSRES_USE_STATIC"] = @"1";
        task.environment = env;

        NSError* err = nil;
        if (![task launchAndReturnError:&err]) {
            log::error("popout", std::string("NSTask launch failed: ")
                                    + (err ? [[err localizedDescription] UTF8String] : "unknown"));
            return false;
        }
        log::info("popout", std::string("Companion (dev) launched, pid=")
                               + std::to_string(task.processIdentifier));
        child_pid = static_cast<int>(task.processIdentifier);
        return true;
    }
};

PopoutSession::PopoutSession(std::string config_json, bool recovery_required,
    bool input_is_pending, std::string retained_snapshot)
    : impl_(std::make_unique<Impl>()) {
    impl_->config_json = std::move(config_json);
    impl_->recovery_required = recovery_required;
    impl_->input_is_pending = input_is_pending;
    impl_->retained_snapshot = std::move(retained_snapshot);
}

PopoutSession::ResultState PopoutSession::read_result(std::string& result, uint64_t& revision,
    std::string& error, std::string* retained_snapshot) const {
    return impl_->read_result(result, revision, error, retained_snapshot);
}

void PopoutSession::mark_applied(uint64_t revision, std::string accepted_config) {
    std::lock_guard<std::mutex> lock(impl_->applied_mutex);
    impl_->applied_config.swap(accepted_config);
    impl_->applied_revision.store(revision);
}

PopoutSession::~PopoutSession() = default;

const std::string& PopoutSession::status_path() const {
    return impl_->status_path;
}

int PopoutSession::child_pid() const {
    return impl_->child_pid;
}

bool PopoutSession::prepare(const std::string& exchange_parent) {
    if (impl_->preparation_attempted) return impl_->files_prepared;
    impl_->preparation_attempted = true;
    if (exchange_parent.empty() || exchange_parent.front() != '/') return false;
    impl_->files_prepared = impl_->prepare_files(exchange_parent);
    return impl_->files_prepared;
}

bool PopoutSession::launch() {
    if (impl_->launch_attempted) return false;
    impl_->launch_attempted = true;
    @autoreleasepool {
        if (!impl_->preparation_attempted) {
            NSString* tmp = NSTemporaryDirectory();
            if (!tmp || !prepare(std::string([tmp UTF8String]))) return false;
        }
        if (!impl_->files_prepared) return false;

        if (impl_->launch_shipped()) return true;

        NSString* dev_dir = read_dev_companion_path();
        if (dev_dir && impl_->launch_dev(dev_dir)) return true;

        log::error("popout",
            "No VapourSynth Companion found. Either install "
            "/Applications/VapourSynth Companion.app, or run "
            "scripts/setup-dev-companion.sh to register a dev path.");
        return false;
    }
}

}  // namespace vsres::macos
