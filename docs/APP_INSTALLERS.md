# Mobile and desktop app installers

The `Build Android APK and Windows installer` workflow produces downloadable test artifacts for the current `main` source tree.

## Android APK

The Android job generates a Capacitor Android wrapper, bundles the compiled web UI into the APK, and uploads `app-debug.apk` as `tron-token-studio-android-debug-apk`.

This is a debug-signed test APK, not a Play Store release. It does not include a release keystore and must not be represented as a production-signed Android package. A release build requires a managed signing keystore, protected CI secrets, release-signing review, and device testing.

The Capacitor app uses the local origin `https://localhost`. The public API smoke workflow verifies that this exact origin can request an identity-only wallet login challenge. Configure the additive backend variable `PACKAGED_APP_ORIGINS=https://localhost,tronstudio://app`; this leaves the existing `FRONTEND_ORIGIN` value untouched. Do not add wildcards. The local wallet creation/import flow is documented in [WALLET_VAULT.md](WALLET_VAULT.md).

## Windows desktop installer

The Windows job creates a locally bundled desktop renderer and packages it with Electron 45 into an NSIS installer, uploaded as `tron-token-studio-windows-x64-unsigned-installer`.

The app renderer runs in a sandboxed window with Node integration disabled, context isolation enabled, and a constrained `tronstudio://app` local asset origin. Outbound links are opened externally only when they use HTTPS. This installer is unsigned; Windows SmartScreen may warn about it. Authenticode signing requires an organization-controlled certificate and protected signing workflow and is intentionally not fabricated here.

The backend CORS allowlist must include the exact desktop origin `tronstudio://app` for desktop API requests. The optional additive `PACKAGED_APP_ORIGINS` variable includes both packaged origins without overwriting any existing web frontend origin. CORS is not authentication, and all privileged API routes must continue to enforce server-side authorization.

## Obtain the artifacts

1. Open the repository's **Actions** page.
2. Select the latest successful **Build Android APK and Windows installer** run.
3. Download the Android and Windows artifacts from the run's Artifacts section.

Artifacts are retained for 14 days. The workflow builds artifacts; it does not publish a release or upload installers to third-party stores.

## Functional limitations

Packaging proves that the web UI can be bundled into the target wrapper; it does not prove that an external wallet injects a signing provider inside Android WebView or Electron. Test wallet connection and signing on supported devices before relying on those features. Sponsored transfer submission remains gated until sponsor consent, funded budgets, provider/signer authorization, end-to-end settlement verification, and security review are complete. No app installer should imply that external exchanges credit deposits before the exchange confirms them.
