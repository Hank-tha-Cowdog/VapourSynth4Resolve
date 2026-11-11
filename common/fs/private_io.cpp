#include "private_io.h"

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace vsres::fs {

namespace {

std::string errno_text() { return std::strerror(errno); }

// A directory component is acceptable only when it is a real directory
// (never a symlink), owned by this user.
bool verify_dir_component(const std::string& path, std::string* out_err) {
    struct stat st{};
    if (::lstat(path.c_str(), &st) != 0) {
        if (out_err) *out_err = "parent " + path + " unreadable: " + errno_text();
        return false;
    }
    if (S_ISLNK(st.st_mode)) {
        if (out_err) *out_err = "parent " + path + " is a symlink — refused";
        return false;
    }
    if (!S_ISDIR(st.st_mode)) {
        if (out_err) *out_err = "parent " + path + " is not a directory";
        return false;
    }
    if (st.st_uid != ::geteuid()) {
        if (out_err) *out_err = "parent " + path + " is not owned by this user";
        return false;
    }
    return true;
}

bool tighten_to_0700(const std::string& path, std::string* out_err) {
    struct stat st{};
    if (::lstat(path.c_str(), &st) != 0) {
        if (out_err) *out_err = "lstat refused: " + errno_text();
        return false;
    }
    if (S_ISLNK(st.st_mode) || !S_ISDIR(st.st_mode)) {
        if (out_err) *out_err = "refused: " + path + " is not a real directory";
        return false;
    }
    if (st.st_uid != ::geteuid()) {
        if (out_err) *out_err = "refused: " + path + " is not owned by this user";
        return false;
    }
    if ((st.st_mode & 0777) != 0700 && ::chmod(path.c_str(), 0700) != 0) {
        if (out_err) *out_err = "could not tighten " + path + ": " + errno_text();
        return false;
    }
    return true;
}

}  // namespace

bool ensure_private_dir(const std::string& path, bool check_parents, std::string* out_err) {
    if (check_parents) {
        // Bounded walk from the immediate parent up to $HOME (inclusive).
        // Everything below $HOME must be a real, user-owned directory; the
        // walk stops AT $HOME because the components above it are
        // system-owned by design (/Users, /).
        const char* home_env = std::getenv("HOME");
        const std::string home = home_env && *home_env ? std::string(home_env) : std::string();
        std::string parent = path;
        for (int hops = 0; hops < 8; ++hops) {
            const auto slash = parent.find_last_of('/');
            if (slash == std::string::npos || slash == 0) break;
            parent = parent.substr(0, slash);
            if (!verify_dir_component(parent, out_err)) return false;
            if (!home.empty() && parent == home) break;
        }
    }
    struct stat st{};
    if (::lstat(path.c_str(), &st) == 0) {
        return tighten_to_0700(path, out_err);
    }
    if (errno != ENOENT) {
        if (out_err) *out_err = "lstat refused: " + errno_text();
        return false;
    }
    if (::mkdir(path.c_str(), 0700) == 0) return true;
    if (errno == EEXIST) {
        // Lost a creation race — re-verify the winner without following it.
        return tighten_to_0700(path, out_err);
    }
    if (out_err) *out_err = "mkdir refused: " + errno_text();
    return false;
}

bool write_private_file(const std::string& path, const std::string& content,
                        std::string* out_err) {
    // No O_TRUNC here: truncation happens after the descriptor checks so a
    // swap cannot destroy content before we verified what we opened.
    const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) {
        if (out_err) *out_err = "open refused (symlink or permissions): " + errno_text();
        return false;
    }
    struct stat st{};
    if (::fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != ::geteuid()) {
        ::close(fd);
        if (out_err) *out_err = "refused: target is not a regular file owned by this user";
        return false;
    }
    if (st.st_nlink > 1) {
        ::close(fd);
        if (out_err) *out_err = "refused: target has multiple hard links";
        return false;
    }
    if ((st.st_mode & 0777) != 0600 && ::fchmod(fd, 0600) != 0) {
        ::close(fd);
        if (out_err) *out_err = "could not tighten mode to 0600: " + errno_text();
        return false;
    }
    if (::ftruncate(fd, 0) != 0) {
        ::close(fd);
        if (out_err) *out_err = "truncate failed: " + errno_text();
        return false;
    }
    ssize_t off = 0;
    while (off < static_cast<ssize_t>(content.size())) {
        const ssize_t n = ::write(fd, content.data() + off, content.size() - off);
        if (n < 0) {
            ::close(fd);
            if (out_err) *out_err = "write failed: " + errno_text();
            return false;
        }
        off += n;
    }
    ::close(fd);
    return true;
}

}  // namespace vsres::fs
