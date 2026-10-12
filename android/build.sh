#!/bin/sh
# Builds the NFC companion app with the Android SDK tools alone (no Gradle, no dependency).
# Needs: a JDK 11+ and an Android SDK with build-tools and a platform.
# Output: android/build/3d-print-dashboard-nfc.apk, to install with "adb install -r".
set -eu
cd "$(dirname "$0")"

VERSION_CODE=1
VERSION_NAME=1.0
MIN_SDK=26
TARGET_SDK=36

SDK=${ANDROID_HOME:-$HOME/Library/Android/sdk}
TOOLS=${ANDROID_BUILD_TOOLS:-$SDK/build-tools/36.0.0}
PLATFORM=$SDK/platforms/android-$TARGET_SDK/android.jar
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@17 ]; then
  JAVA_HOME=/opt/homebrew/opt/openjdk@17
fi
export JAVA_HOME
PATH=$JAVA_HOME/bin:$PATH

# Personal builds are signed with the standard Android debug key, kept outside the repository.
# Updates must be signed with the same key, or the app has to be uninstalled first.
KEYSTORE=$HOME/.android/debug.keystore
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

rm -rf build
mkdir -p build/gen build/classes build/dex
"$TOOLS/aapt2" compile --dir res -o build/res.zip
"$TOOLS/aapt2" link -o build/unsigned.apk -I "$PLATFORM" --manifest AndroidManifest.xml \
  --java build/gen --min-sdk-version $MIN_SDK --target-sdk-version $TARGET_SDK \
  --version-code $VERSION_CODE --version-name $VERSION_NAME build/res.zip
javac -Xlint:-options -source 11 -target 11 -classpath "$PLATFORM" -d build/classes \
  $(find src build/gen -name '*.java')
"$TOOLS/d8" --lib "$PLATFORM" --min-api $MIN_SDK --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q -j ../unsigned.apk classes.dex)
"$TOOLS/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android \
  --out build/3d-print-dashboard-nfc.apk build/aligned.apk
rm -f build/unsigned.apk build/aligned.apk build/*.idsig
echo "Built android/build/3d-print-dashboard-nfc.apk"
