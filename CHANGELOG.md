# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Security and correctness

- Verify Nostr signatures and current maintainer authority with exact repository/application coordinates; reject unlinked legacy releases and cross-repository heuristics.
- Reconcile addressable revisions by publisher/d-tag and process linkage revocations.
- Authenticate pipeline run signers and publisher delegations; select one run instead of historical filename voting.
- Preserve independent asset identity/version, filenames, platforms and APK metadata; expose bounded local-file SHA-256 checking without claiming native-signature verification.
- Pin signer/repository scope, sign all templates first, and resume a locally saved fixed-event publication after partial outcomes.
- Handle logout/context changes, late subscription startup/disposal, partial relay pages and unresolved assets explicitly.
- Correct unsubscribe permission, host sandbox/origin expectations and manifest URL expansion.

### Verification and packaging

- Replace scaffold tests with signed domain fixtures and controlled-host Chromium flows.
- Use Svelte-check; measure executable domain coverage separately from browser-tested Svelte markup.
- Require Node 22.12+, cover the master branch in CI and use supported artifact/cache actions.
- Document the actual Budabit repo-tab/SDK 0.2 wire contract and security limits.

### Added

- Initial project scaffolded with `create-budabit-widget`
- Svelte 5 iframe app with bridge protocol demo
- Smart Widget manifest generation via `budabit-sdk`
- Unit tests (Vitest) and E2E tests (Playwright)
- CI/CD pipeline with GitHub Actions
- Publishing workflows (Blossom, GitHub Releases, manual)
