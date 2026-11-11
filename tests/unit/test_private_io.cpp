// Private-write and directory helpers — real filesystem checks inside a
// self-owned tmp tree. Exercises: new-file 0600, existing-file mode
// migration (fchmod), symlink refusal at file and directory components,
// hardlink refusal, directory tightening, parent-chain verification.
// Never touches owner data: everything lives under a fresh mkdtemp root.

#include "../../common/fs/private_io.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {

int fail(const char* msg) {
    std::fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

std::string read_file(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

mode_t mode_of(const std::string& path) {
    struct stat st{};
    if (::lstat(path.c_str(), &st) != 0) return 0;
    return st.st_mode & 0777;
}

bool write_raw(const std::string& path, const std::string& content, mode_t mode) {
    const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) return false;
    ssize_t off = 0;
    while (off < static_cast<ssize_t>(content.size())) {
        const ssize_t n = ::write(fd, content.data() + off, content.size() - off);
        if (n < 0) { ::close(fd); return false; }
        off += n;
    }
    ::close(fd);
    return true;
}

struct TmpRoot {
    std::string path;
    TmpRoot() {
        char tmpl[] = "/tmp/vsres-private-io-XXXXXX";
        const char* made = ::mkdtemp(tmpl);
        path = made ? made : "";
    }
    ~TmpRoot() {
        if (path.empty()) return;
        // Best-effort recursive cleanup (children first, bounded depth).
        std::string cmd = "rm -rf '" + path + "'";
        if (::system(cmd.c_str()) != 0) { /* temp tree only */ }
    }
};

int test_new_file_created_0600() {
    TmpRoot root;
    if (root.path.empty()) return fail("mkdtemp failed");
    const std::string file = root.path + "/sidecar.json";
    if (!vsres::fs::write_private_file(file, "synthetic sidecar")) return fail("fresh write");
    if (read_file(file) != "synthetic sidecar") return fail("fresh write content");
    if (mode_of(file) != 0600) return fail("fresh file must be 0600");
    return 0;
}

int test_existing_0644_is_tightened_and_replaced() {
    TmpRoot root;
    const std::string file = root.path + "/old-mode.json";
    if (!write_raw(file, "old content", 0644)) return fail("fixture write");
    if (!vsres::fs::write_private_file(file, "new content")) return fail("migrating write");
    if (read_file(file) != "new content") return fail("migrating write content");
    if (mode_of(file) != 0600) return fail("existing 0644 must be tightened to 0600");
    return 0;
}

int test_final_symlink_is_refused_untouched() {
    TmpRoot root;
    const std::string victim = root.path + "/victim.txt";
    if (!write_raw(victim, "victim content", 0600)) return fail("victim fixture");
    const std::string link = root.path + "/link.json";
    if (::symlink(victim.c_str(), link.c_str()) != 0) return fail("symlink fixture");
    std::string err;
    if (vsres::fs::write_private_file(link, "replacement", &err)) return fail("symlink write must be refused");
    if (read_file(victim) != "victim content") return fail("symlink target must be untouched");
    if (err.find("refused") == std::string::npos) return fail("refusal reason present");
    return 0;
}

int test_hardlinked_target_is_refused() {
    TmpRoot root;
    const std::string original = root.path + "/original.json";
    if (!write_raw(original, "original content", 0600)) return fail("hardlink fixture");
    const std::string alias = root.path + "/alias.json";
    if (::link(original.c_str(), alias.c_str()) != 0) return fail("hardlink create");
    if (vsres::fs::write_private_file(alias, "replacement")) return fail("hardlinked write must be refused");
    if (read_file(original) != "original content") return fail("hardlink target must be untouched");
    if (read_file(alias) != "original content") return fail("hardlink alias must be untouched");
    return 0;
}

int test_directory_create_verify_and_tighten() {
    TmpRoot root;
    // Synthetic HOME so check_parents stops there (system dirs above are
    // root-owned and must not be part of the check).
    const std::string home = root.path + "/home";
    if (::mkdir(home.c_str(), 0700) != 0) return fail("home fixture");
    if (::mkdir((home + "/Library").c_str(), 0755) != 0) return fail("library fixture");
    if (::mkdir((home + "/Library/Application Support").c_str(), 0755) != 0) return fail("app support fixture");
    ::setenv("HOME", home.c_str(), 1);

    const std::string product = home + "/Library/Application Support/VapourSynth-OFX";
    if (!vsres::fs::ensure_private_dir(product, /*check_parents=*/true)) return fail("product create");
    if (mode_of(product) != 0700) return fail("product dir must be 0700");

    // Existing broader mode is tightened on the next ensure (migration).
    if (::chmod(product.c_str(), 0755) != 0) return fail("widen fixture");
    if (!vsres::fs::ensure_private_dir(product, /*check_parents=*/true)) return fail("tighten pass");
    if (mode_of(product) != 0700) return fail("existing 0755 must be tightened to 0700");

    // A symlinked parent component must refuse the whole chain.
    const std::string elsewhere = root.path + "/elsewhere";
    if (::mkdir(elsewhere.c_str(), 0700) != 0) return fail("elsewhere fixture");
    const std::string symlinked = home + "/Library/Application Support/link";
    if (::symlink(elsewhere.c_str(), symlinked.c_str()) != 0) return fail("parent symlink fixture");
    std::string err;
    if (vsres::fs::ensure_private_dir(symlinked + "/sub", /*check_parents=*/true, &err)) {
        return fail("symlinked parent must be refused");
    }
    struct stat st{};
    if (::lstat((elsewhere + "/sub").c_str(), &st) == 0) return fail("nothing may be created through the symlink");

    // A non-directory component is refused too.
    const std::string as_file = home + "/Library/Application Support/not-a-dir";
    if (!write_raw(as_file, "x", 0600)) return fail("file fixture");
    if (vsres::fs::ensure_private_dir(as_file + "/child", /*check_parents=*/true)) {
        return fail("non-directory parent must be refused");
    }
    return 0;
}

}  // namespace

int main() {
    struct Case { const char* name; int (*run)(); };
    const Case cases[] = {
        {"new_file_created_0600", test_new_file_created_0600},
        {"existing_0644_is_tightened_and_replaced", test_existing_0644_is_tightened_and_replaced},
        {"final_symlink_is_refused_untouched", test_final_symlink_is_refused_untouched},
        {"hardlinked_target_is_refused", test_hardlinked_target_is_refused},
        {"directory_create_verify_and_tighten", test_directory_create_verify_and_tighten},
    };
    int rc = 0;
    for (const auto& test : cases) {
        const int result = test.run();
        rc |= result;
        std::fprintf(stderr, "PRIVATE_IO_CASE_%s %s\n", result == 0 ? "PASS" : "FAIL", test.name);
    }
    if (rc == 0) std::fprintf(stderr, "all tests passed; cases=%zu\n", sizeof(cases) / sizeof(cases[0]));
    return rc;
}
