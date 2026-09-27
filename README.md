# ascship

Ship iOS apps from the terminal with one App Store Connect API key. Early days: only `doctor` exists so far.

## Install

Needs macOS and Node 18+. Not on npm yet:

```sh
npm install -g github:6LebronJames23/ascship
```

## doctor

Checks an exported `.ipa` before you upload it. macOS only (uses `codesign`, `security`, `plutil`).

```sh
# record a known-good build's entitlements as the expected set
ascship doctor --ipa Good.ipa --snapshot

# check every later build against it
ascship doctor --ipa MyApp.ipa          # exit 1 if anything fails
ascship doctor --ipa MyApp.ipa --json   # for CI and coding agents
```

For every bundle in the IPA (app, extensions, watch app, app clip) it checks:

- **Signature** is valid (`codesign --verify --strict`).
- **Profile** is present, not expired, and on the main app's team.
- **The release claims what it needs:** entitlements in the exported signature vs the expected list in `ascship.yaml`. Catches entitlements dropped before signing, such as an xcodegen regenerate wiping push or Sign in with Apple.
- **The profile allows what the app claims.** The profile is an allowlist that may contain wildcards, so this is a separate check, never an exact diff (Apple TN3125).
- **Built-in rules:** App Store builds need `aps-environment = production` and `get-task-allow = false`; `application-identifier` must match team + bundle id.

`ascship.yaml`:

```yaml
entitlements:
  MyApp:                # bundle name without .app / .appex
    app-store:          # app-store | ad-hoc | development | enterprise
      aps-environment: production
      com.apple.developer.applesignin: [Default]
      com.apple.security.application-groups: [group.com.example.myapp]
  MyWidget:
    app-store:
      com.apple.security.application-groups: [group.com.example.myapp]
```

Arrays mean "must include at least these"; scalars must match exactly.
