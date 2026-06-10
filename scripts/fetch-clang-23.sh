#!/bin/sh
# --with-win64 fetches clang-cl for Linux/macOS Windows cross builds.
set -eu

tc_base="https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3"
host_dest="$HOME/.mozbuild/clang-23"
sysroot="$HOME/.mozbuild/sysroot-wasm32-wasi"
fetch_win64=0

usage() {
    echo "usage: scripts/fetch-clang-23.sh [--with-win64]" >&2
    exit 2
}

for arg do
    case "$arg" in
        --with-win64)
            fetch_win64=1
            ;;
        *)
            usage
            ;;
    esac
done

case "${FETCH_WIN64_CLANG:-}" in
    1|yes|true)
        fetch_win64=1
        ;;
esac

unpack_tar_zst() {
    archive="$1"
    out="$2"

    if tar --zstd --strip-components=1 -xf "$archive" -C "$out" 2>/dev/null; then
        :
    elif command -v zstd >/dev/null 2>&1; then
        zstd -dc "$archive" | tar -x --strip-components=1 -C "$out"
    elif command -v 7z >/dev/null 2>&1; then
        7z x "$archive" -so | tar -x --strip-components=1 -C "$out"
    else
        tar --strip-components=1 -xf "$archive" -C "$out"
    fi
}

install_clang() {
    ns="$1"
    dest="$2"
    clang_bin="$3"
    runnable="$4"

    url="$tc_base.${ns}.latest/artifacts/public/build/clang.tar.zst"

    if [ -f "$clang_bin" ]; then
        echo "fetch-clang-23: $ns already present, skipping download."
    else
        echo "fetch-clang-23: downloading $ns ..."
        rm -rf "$dest"
        mkdir -p "$dest"
        curl -L --retry 5 --fail -o "$dest/clang.tar.zst" "$url"
        unpack_tar_zst "$dest/clang.tar.zst" "$dest"
        rm -f "$dest/clang.tar.zst"
    fi

    if [ "$runnable" -eq 1 ]; then
        if [ ! -x "$clang_bin" ]; then
            echo "fetch-clang-23: ERROR: clang not found at $clang_bin" >&2
            exit 1
        fi
        "$clang_bin" --version
    else
        if [ ! -f "$clang_bin" ]; then
            echo "fetch-clang-23: ERROR: clang not found at $clang_bin" >&2
            exit 1
        fi
        echo "fetch-clang-23: installed $ns in $dest."
    fi
}

install_sysroot() {
    sysroot_url="$tc_base.sysroot-wasm32-wasi-clang-23.latest/artifacts/public/build/sysroot-wasm32-wasi.tar.zst"

    if [ ! -f "$sysroot/.clang-23" ] ||
       [ ! -d "$sysroot/lib/wasm32-wasip1" ] ||
       [ ! -d "$sysroot/include/wasm32-wasip1" ]; then
        echo "fetch-clang-23: downloading wasi sysroot ..."
        rm -rf "$sysroot"
        mkdir -p "$sysroot"
        curl -L --retry 5 --fail -o "$sysroot.tar.zst" "$sysroot_url"
        unpack_tar_zst "$sysroot.tar.zst" "$sysroot"
        rm -f "$sysroot.tar.zst"
    fi

    if [ ! -d "$sysroot/lib/wasm32-wasip1" ] ||
       [ ! -d "$sysroot/include/wasm32-wasip1" ]; then
        echo "fetch-clang-23: ERROR: wasi sysroot not found after download." >&2
        exit 1
    fi

    touch "$sysroot/.clang-23"
    echo "fetch-clang-23: prepared wasi sysroot."
}

host_key="$(uname -s)-$(uname -m)"
host_clang="$host_dest/bin/clang"

case "$host_key" in
    Linux-x86_64)
        host_ns="linux64-clang-23"
        ;;
    Linux-aarch64|Linux-arm64)
        host_ns="linux64-aarch64-clang-23"
        ;;
    Darwin-arm64)
        host_ns="macosx64-aarch64-clang-23"
        ;;
    Darwin-x86_64)
        host_ns="macosx64-clang-23"
        ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
        host_ns="win64-clang-23"
        host_clang="$host_dest/bin/clang.exe"
        fetch_win64=0
        ;;
    *)
        echo "fetch-clang-23: unsupported host $host_key" >&2
        exit 1
        ;;
esac

install_clang "$host_ns" "$host_dest" "$host_clang" 1

if [ "$fetch_win64" -eq 1 ] && [ "$host_ns" != "win64-clang-23" ]; then
    win64_dest="$HOME/.mozbuild/clang-23-win64"
    install_clang "win64-clang-23" "$win64_dest" "$win64_dest/bin/clang.exe" 0
fi

install_sysroot

echo "fetch-clang-23: done."
