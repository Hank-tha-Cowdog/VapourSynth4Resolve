// Launch-free real-file lifecycle checks for PopoutSession. Opt-in native target.
// Requires an already-created empty0700 caller-owned root; never calls launch().
#include "../../platform/macos/host/popout_launcher.h"
#include "../../common/config/config.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace fs = std::filesystem;
using Session = vsres::macos::PopoutSession;
using State = Session::ResultState;
using Json = vsres::config::Json;

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
void put(const fs::path& path, const std::string& text, bool exclusive = false) {
    const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC |
        (exclusive ? O_EXCL : O_TRUNC), 0600);
    require(fd >= 0, "synthetic output open failed");
    struct Fd { int value; ~Fd() { if (value >= 0) close(value); } } owned{fd};
    size_t offset = 0;
    while (offset < text.size()) {
        const ssize_t count = write(fd, text.data() + offset, text.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        require(count > 0, "synthetic output write failed");
        offset += static_cast<size_t>(count);
    }
    owned.value = -1;
    require(close(fd) == 0, "synthetic output close outcome unknown");
}
std::string contents(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    require(in.is_open(), "synthetic fixture read failed");
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}
fs::path directory(const Session& session) { return fs::path(session.status_path()).parent_path(); }
fs::path result_path(const Session& session) { return directory(session) / "result.json"; }
Json configuration(const char* name = "synthetic-node") {
    return {{"schemaVersion", 1}, {"nodeId", name}, {"chain", Json::array()}, {"mix", 1.0}};
}
std::string envelope(const Session& session, uint64_t revision, Json config = configuration()) {
    return Json{{"sessionId", directory(session).filename().string()}, {"revision", revision},
                {"config", std::move(config)}}.dump();
}
void publish(const Session& session, const std::string& body) {
    const fs::path pending = directory(session) / "synthetic-next.json";
    put(pending, body, true);
    require(rename(pending.c_str(), result_path(session).c_str()) == 0, "synthetic atomic publish failed");
}
State read(const Session& session, std::string* accepted = nullptr, std::string* snapshot = nullptr) {
    std::string result, error;
    uint64_t revision = 0;
    const auto state = session.read_result(result, revision, error, snapshot);
    if (accepted) *accepted = result;
    return state;
}
void prepare(Session& session, const fs::path& root) {
    require(session.prepare(root.string()), "launch-free preparation failed");
    require(directory(session).parent_path() == root, "exchange escaped caller root");
}
void check_mode(const fs::path& path, mode_t expected, bool is_directory) {
    struct stat st{};
    require(lstat(path.c_str(), &st) == 0, "owned path missing");
    require((st.st_mode & 0777) == expected && st.st_uid == geteuid(), "owned path mode/uid mismatch");
    require(is_directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode), "owned path type mismatch");
}
} // namespace

int main() {
    const char* named_root = std::getenv("VSRES_NATIVE_TEST_ROOT");
    if (!named_root || named_root[0] != '/') {
        std::fprintf(stderr, "FAIL: explicit absolute VSRES_NATIVE_TEST_ROOT required\n"); return 1;
    }
    const fs::path root(named_root);
    struct stat st{};
    if (lstat(root.c_str(), &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() ||
        (st.st_mode & 0777) != 0700 || !fs::is_empty(root)) {
        std::fprintf(stderr, "FAIL: test root must be fresh empty caller-owned0700 directory\n"); return 1;
    }
    // Hold sessions beyond each case's stack so an exception cannot erase its
    // failing input. Clear only on a successful case; intentional destructor
    // cases explicitly pop at their lifecycle checkpoint.
    std::vector<std::unique_ptr<Session>> sessions;
    auto make_session = [&](std::string config = configuration().dump(), bool recovery = false,
                            bool pending = false, std::string snapshot = {}) -> Session& {
        sessions.push_back(std::make_unique<Session>(std::move(config), recovery, pending,
                                                     std::move(snapshot)));
        return *sessions.back();
    };
    struct Case { const char* name; std::function<void()> run; };
    const std::vector<Case> cases = {
        {"distinct private generations and fixed-file modes", [&] {
            Session& a = make_session(); Session& b = make_session(); prepare(a, root); prepare(b, root);
            require(directory(a) != directory(b), "generation collision");
            check_mode(directory(a), 0700, true);
            for (const char* leaf : {"config.json", "result.json", "status.json"}) check_mode(directory(a) / leaf, 0600, false);
            require(read(a) == State::Empty, "initial result is not empty");
        }},
        {"preparation is one-shot including known failure", [&] {
            Session& a = make_session(); prepare(a, root); const auto original = directory(a);
            const auto body = envelope(a, 1); publish(a, body);
            require(a.prepare(root.string()) && directory(a) == original, "prepare changed generation");
            require(contents(result_path(a)) == body, "prepare truncated pending data");
            Session& failed = make_session(); require(!failed.prepare("relative-parent"), "relative parent accepted");
            require(!failed.prepare(root.string()) && failed.status_path().empty(), "failed preparation silently retried");
        }},
        {"accepted revision binds exact canonical payload", [&] {
            Session& a = make_session(); prepare(a, root); publish(a, envelope(a, 2)); std::string accepted;
            require(read(a, &accepted) == State::Ready, "valid result refused");
            a.mark_applied(2, accepted); require(read(a) == State::AlreadyApplied, "accepted payload not recognized");
            publish(a, envelope(a, 1)); require(read(a) == State::Invalid, "stale revision misreported applied");
            publish(a, envelope(a, 2, configuration("synthetic-conflict")));
            require(read(a) == State::Invalid, "same-number conflicting payload misreported applied");
            publish(a, envelope(a, 3)); require(read(a) == State::Ready, "new revision refused");
        }},
        {"session and revision transport negatives", [&] {
            Session& a = make_session(); prepare(a, root);
            auto body = Json::parse(envelope(a, 1)); body["sessionId"] = "synthetic-wrong-session";
            publish(a, body.dump()); require(read(a) == State::Invalid, "foreign session accepted");
            for (const Json revision : {Json(0), Json(-1), Json(1.5), Json(uint64_t(9007199254740992ULL))}) {
                body = Json::parse(envelope(a, 1)); body["revision"] = revision;
                publish(a, body.dump()); require(read(a) == State::Invalid, "invalid revision accepted");
            }
        }},
        {"invalid known shapes retain complete bounded raw snapshot", [&] {
            Session& a = make_session(); prepare(a, root);
            std::vector<std::string> bad = {"{synthetic-invalid", "[]"};
            for (Json cfg : {Json{{"chain", nullptr}}, Json{{"chain", Json::array({nullptr})}},
                Json{{"chain", Json::array({Json{{"params", Json::array()}}})}},
                Json{{"chain", Json::array({Json{{"stage", uint64_t(2147483648ULL)}}})}}}) {
                bad.push_back(envelope(a, 1, cfg));
            }
            for (const auto& text : bad) {
                publish(a, text); std::string accepted, snapshot;
                require(read(a, &accepted, &snapshot) == State::Invalid, "invalid shape accepted");
                require(accepted.empty() && snapshot == text, "bounded invalid raw snapshot lost");
            }
            auto cfg = configuration(); cfg["chain"] = Json::array({Json{{"params", Json{{"unknownFilterValue", "synthetic"}}}}});
            publish(a, envelope(a, 1, cfg)); require(read(a) == State::Ready, "transport guard became global filter validator");
        }},
        {"missing symlink and FIFO results refuse without following or blocking", [&] {
            Session& a = make_session(); prepare(a, root); require(unlink(result_path(a).c_str()) == 0, "unlink fixture failed");
            require(read(a) == State::Invalid, "missing result accepted");
            const fs::path sentinel = directory(a) / "synthetic-sentinel.txt"; put(sentinel, "synthetic sentinel");
            require(symlink(sentinel.c_str(), result_path(a).c_str()) == 0, "symlink fixture failed");
            std::string snapshot; require(read(a, nullptr, &snapshot) == State::Invalid && snapshot.empty(), "symlink followed");
            require(contents(sentinel) == "synthetic sentinel", "symlink target modified");
            require(unlink(result_path(a).c_str()) == 0 && mkfifo(result_path(a).c_str(), 0600) == 0, "FIFO fixture failed");
            require(read(a) == State::Invalid, "nonregular result accepted");
            require(unlink(sentinel.c_str()) == 0, "sentinel cleanup failed");
        }},
        {"oversized sparse result refuses before raw snapshot allocation", [&] {
            Session& a = make_session(); prepare(a, root);
            const int fd = open(result_path(a).c_str(), O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
            require(fd >= 0, "oversize fixture open failed"); const int rc = ftruncate(fd, 8 * 1024 * 1024 + 1);
            const int closed = close(fd); require(rc == 0 && closed == 0, "oversize fixture failed");
            std::string snapshot; require(read(a, nullptr, &snapshot) == State::Invalid && snapshot.empty(), "oversize result captured");
        }},
        {"atomic publication and older generation isolation", [&] {
            Session& older = make_session(); Session& newer = make_session(); prepare(older, root); prepare(newer, root);
            const auto fresh = envelope(newer, 1, configuration("synthetic-new")); publish(newer, fresh);
            publish(older, envelope(older, 1, configuration("synthetic-old")));
            require(contents(result_path(newer)) == fresh && read(newer) == State::Ready, "older generation replaced fresh data");
            publish(newer, envelope(newer, 2)); require(read(newer) == State::Ready, "atomic inode replacement missed");
        }},
        {"retained prior raw body is private and removed with owned files", [&] {
            fs::path dir;
            { Session& a = make_session(configuration().dump(), true, false, "synthetic retained raw"); prepare(a, root); dir = directory(a);
              const auto path = dir / "prior-result.raw.json"; check_mode(path, 0600, false);
              require(contents(path) == "synthetic retained raw", "retained snapshot mismatch"); }
            sessions.pop_back();  // exercise the real destructor at this explicit checkpoint
            require(!fs::exists(dir), "owned normal directory not cleaned");
        }},
        {"destructor never recursively deletes an unknown entry", [&] {
            fs::path dir;
            { Session& a = make_session(); prepare(a, root); dir = directory(a); put(dir / "synthetic-unknown.txt", "keep"); }
            sessions.pop_back();  // exercise fixed-only destructor cleanup intentionally
            require(contents(dir / "synthetic-unknown.txt") == "keep", "unknown entry deleted");
            require(!fs::exists(dir / "config.json") && !fs::exists(dir / "result.json"), "known files left behind");
            require(unlink((dir / "synthetic-unknown.txt").c_str()) == 0 && rmdir(dir.c_str()) == 0, "owned unknown fixture cleanup failed");
        }},
    };
    size_t passed = 0;
    try {
        for (const auto& test : cases) {
            std::fprintf(stderr, "RUN %zu %s\n", passed + 1, test.name); test.run(); sessions.clear(); ++passed;
            std::fprintf(stderr, "PASS %zu %s\n", passed, test.name);
        }
        require(fs::is_empty(root), "successful suite left owned residue");
    } catch (const std::exception& error) {
        // Deliberately leave failed session files to the caller. Process exit
        // releases memory; running destructors here would destroy evidence.
        // Files already removed by explicit destructor cases cannot be restored.
        for (auto& session : sessions) (void)session.release();
        std::fprintf(stderr, "FAIL case=%zu reason=%s; preserve caller test root for inspection\n", passed + 1, error.what());
        return 1;
    }
    std::fprintf(stderr, "PASS companion_exchange cases=%zu; no companion launch/OFX/VS/Resolve API calls\n", passed);
    return 0;
}
