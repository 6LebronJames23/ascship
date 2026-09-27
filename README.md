# ascship

Ship iOS apps from the terminal with one App Store Connect API key. Early days: only `doctor` exists so far; the App Store Connect commands (profile, build, listing, submit) are next.

## Install

Needs macOS and Node 18+. Not on npm yet:

```sh
npm install -g github:6LebronJames23/ascship
```

## doctor

Catches the things that get iOS builds rejected or shipped broken, before you upload. macOS only (uses `codesign`, `security`, `plutil`); no App Store Connect access needed.

```sh
ascship doctor --ipa MyApp.ipa                    # IPA + project versions + listing + previews
ascship doctor --ipa Good.ipa --snapshot          # record a known-good build's entitlements
ascship doctor --preview previews/                # just the App Preview videos
ascship doctor --json                             # for CI and coding agents; exit 1 on any failure
```

It runs every check it has inputs for:

**IPA** (`--ipa`), for every bundle (app, extensions, watch app, app clip):
- Signature valid; profile present, not expired, on the app's team.
- **The release claims what it needs:** exported entitlements vs the expected list in `ascship.yaml`. Catches entitlements dropped before signing, such as an xcodegen regenerate wiping push or Sign in with Apple.
- **The profile allows what the app claims.** The profile is an allowlist that may contain wildcards, so this is a separate check, never an exact diff (Apple TN3125).
- App Store builds need `aps-environment = production` and `get-task-allow = false`; `application-identifier` must match team + bundle id.
- Every extension carries the same version and build as the app.

**Versions** (`--project`, or auto-detected next to `ascship.yaml`):
- `project.yml` vs the generated project: bumped the version but didn't re-run xcodegen.
- IPA vs project: the archive predates the version bump.

**Listing** (`listing:` in `ascship.yaml`):
- Field length limits (name 30, subtitle 30, keywords 100, promotional text 170, description and What's New 4000).
- Emoji in the description or What's New (App Store Connect rejects them).
- Wasted keyword characters: duplicates, words already in the name or subtitle, spaces after commas.

**App Previews** (`--preview`, or `previews:` in `ascship.yaml`):
- Has an audio track (required, even a silent one), 15-30 seconds, at most 30 fps, and a known preview size.
- Reads the MP4/MOV structure directly; ffmpeg not required.

### ascship.yaml

```yaml
entitlements:           # written by --snapshot; edit to taste
  MyApp:                # bundle name without .app / .appex
    app-store:          # app-store | ad-hoc | development | enterprise
      aps-environment: production
      com.apple.developer.applesignin: [Default]
      com.apple.security.application-groups: [group.com.example.myapp]
  MyWidget:
    app-store:
      com.apple.security.application-groups: [group.com.example.myapp]

listing:
  en-US:
    name: "MyApp: Short Pitch"
    subtitle: What it does in 30
    keywords: comma,separated,no,spaces
    whatsNew: Bug fixes and speed improvements.

previews:               # files or folders, relative to this file
  - previews/
```

Entitlement arrays mean "must include at least these"; scalars must match exactly.
