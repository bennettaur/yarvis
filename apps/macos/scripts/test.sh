#!/bin/sh
# Runs `swift test`. With only the Command Line Tools installed (no Xcode),
# swift-testing's framework and its interop library sit outside the default
# search paths, so they are added here. With Xcode, plain `swift test` works.
set -e
cd "$(dirname "$0")/.."
dev="$(xcode-select -p)"
case "$dev" in
  *CommandLineTools*)
    lib="$dev/Library/Developer"
    exec swift test \
      -Xswiftc -F"$lib/Frameworks" \
      -Xlinker -F"$lib/Frameworks" \
      -Xlinker -rpath -Xlinker "$lib/Frameworks" \
      -Xlinker -rpath -Xlinker "$lib/usr/lib" "$@"
    ;;
  *) exec swift test "$@" ;;
esac
