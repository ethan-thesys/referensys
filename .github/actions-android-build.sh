#!/usr/bin/env bash
# Builds the Android app (APK). Used by the release and test workflows.
# Signs with the key in the ANDROID_KEYSTORE secret; without it, makes an unsigned check build only.
set -euo pipefail
V=$(node -p "require('./package.json').version")
CODE=$(node -p "const [a,b,c]=require('./package.json').version.split(/[.-]/).map(Number);a*10000+b*100+(c||0)")
node scripts/build-android-web.js
npx cap sync android
chmod +x android/gradlew
if [ -n "${ANDROID_KEYSTORE:-}" ]; then
  echo "$ANDROID_KEYSTORE" | base64 -d > "$RUNNER_TEMP/referensys.keystore"
  export ANDROID_KEYSTORE_PATH="$RUNNER_TEMP/referensys.keystore"
  (cd android && ./gradlew assembleRelease -PappVersion="$V" -PappVersionCode="$CODE" --no-daemon --stacktrace)
  cp android/app/build/outputs/apk/release/app-release.apk "Referensys-Android-$V.apk"
  echo "apk=Referensys-Android-$V.apk" >> "$GITHUB_OUTPUT"
else
  echo "::warning::No ANDROID_KEYSTORE secret yet, so this is a check build only (not installable as an update)."
  (cd android && ./gradlew assembleDebug -PappVersion="$V" -PappVersionCode="$CODE" --no-daemon --stacktrace)
  echo "apk=" >> "$GITHUB_OUTPUT"
fi
echo "version=$V" >> "$GITHUB_OUTPUT"
