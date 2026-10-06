# Build and release

The current release version is **0.1.1**. The desktop target is **macOS arm64**.

## Version and source

Keep the root, `ui/` and `desktop/` package versions and each lockfile's root package version consistent. Update [CHANGELOG.md](../CHANGELOG.md), installation instructions and the relevant contracts before producing release artifacts.

Release from a known, clean source snapshot. Do not package credentials, `.env`, room logs, native histories, test state or local backups. The Electron configuration copies only the compiled product and staged runtime dependencies.

A repository-history reset is a separate owner operation, not a normal release step. Keep backups before replacing published refs. Rewriting Git history does not by itself remove GitHub pull-request records.

## Validate the source

```sh
npm ci
npm run typecheck
npm run build
npm --prefix desktop ci
npm --prefix desktop run build
node scripts/test-guard.mjs ./node_modules/.bin/tsx --test --test-concurrency=2 'tests/**/*.test.ts'
```

Inspect the real UI using a separate daemon home, workspace and port. Test changed interaction paths and check browser errors. Distinguish deterministic tests from real provider calls.

Private-execution tests on macOS exercise the actual Seatbelt boundary. Unsupported systems may skip those platform tests; do not report that as macOS boundary verification.

## Developer ID signing

A valid Developer ID Application certificate and its private key must be available in the keychain:

```sh
security find-identity -v -p codesigning
AGORYX_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  npm --prefix desktop run dist -- --publish never
```

The config removes the certificate label prefix when passing the identity to electron-builder. Supplying the identity enables hardened runtime, the checked-in entitlements and DMG signing. Without one, the local build is unsigned.

The build stages production dependencies without install scripts and makes the macOS terminal helper executable before signing. Verify the packaged SQLite module and an actual terminal spawn using the system Node runtime, including from a read-only mounted DMG; successful packaging alone is not proof that native modules work.

Expected outputs:

```text
desktop/release/mac-arm64/Agoryx.app
desktop/release/Agoryx-0.1.1-arm64.dmg
```

## Notarize and staple

Configure a notarytool keychain profile once through Apple's normal credential flow. Do not store the Apple ID password or API key in the repository.

With an existing profile named `agoryx`:

```sh
ditto -c -k --keepParent desktop/release/mac-arm64/Agoryx.app /tmp/Agoryx-app.zip
xcrun notarytool submit /tmp/Agoryx-app.zip --keychain-profile agoryx --wait
xcrun stapler staple desktop/release/mac-arm64/Agoryx.app

cd desktop
AGORYX_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  npx --no-install electron-builder --config electron-builder.config.cjs \
  --mac dmg --arm64 --prepackaged release/mac-arm64/Agoryx.app --publish never
xcrun notarytool submit release/Agoryx-0.1.1-arm64.dmg --keychain-profile agoryx --wait
xcrun stapler staple release/Agoryx-0.1.1-arm64.dmg
```

Require an **Accepted** result for both submissions. If Apple rejects a submission, retrieve its log, fix the cause, and resubmit; do not describe the rejected artifact as notarized.

electron-builder's automatic notarization is disabled in this project; explicit notarytool steps use the configured keychain profile.

## Verify the distribution

From the repository root:

```sh
codesign --verify --deep --strict --verbose=2 desktop/release/mac-arm64/Agoryx.app
codesign -dv --verbose=4 desktop/release/mac-arm64/Agoryx.app
xcrun stapler validate desktop/release/mac-arm64/Agoryx.app
spctl --assess --type execute --verbose=2 desktop/release/mac-arm64/Agoryx.app

codesign --verify --strict --verbose=2 desktop/release/Agoryx-0.1.1-arm64.dmg
xcrun stapler validate desktop/release/Agoryx-0.1.1-arm64.dmg
spctl --assess --type open --context context:primary-signature --verbose=2 \
  desktop/release/Agoryx-0.1.1-arm64.dmg
```

Check `CFBundleShortVersionString` and the embedded core package version. Mount the DMG read-only and verify the application inside it matches the released package. Run the packaged core's `doctor --json` with disposable state, and inspect the application startup when testing the shell.

Compute checksums **after** stapling, because stapling changes the artifact:

```sh
cd desktop/release
shasum -a 256 Agoryx-0.1.1-arm64.dmg > SHA256SUMS.txt
```

## Publish

Publish the verified DMG and checksum file to the intended tag and explicitly mark the release as current. When version numbers have been reset, do not rely on semantic-version ordering to select Latest.

```sh
gh release create v0.1.1 \
  desktop/release/Agoryx-0.1.1-arm64.dmg \
  desktop/release/SHA256SUMS.txt \
  --title "Agoryx 0.1.1" --notes-file /path/to/release-notes.md --latest
```

The tag must already identify the intended release snapshot, or be created deliberately for that snapshot. Do not overwrite a published tag as a routine update.

Verify the release URL, asset sizes/checksums, tag target and Latest status after publication. Keep signing/notarization logs and validation evidence outside the repository. Do not equate an upload attempt with a successful public release.
