# ascship

Ship iOS apps from the terminal with one App Store Connect API key. Early days: `init`, `status` and `doctor` work today; profile, build, listing and submit are next.

## Install

Needs macOS and Node 18+. Not on npm yet:

```sh
npm install -g github:6LebronJames23/ascship
```

## init

```sh
ascship init --app com.example.myapp
```

Finds your API key in `~/.appstoreconnect/private_keys` (where `altool` looks), asks for the issuer id, checks both against App Store Connect, and saves them to `~/.config/ascship/credentials.json` (mode 600, outside your repo). `ascship.yaml` only gets the app's id. Create a key under App Store Connect → Users and Access → Integrations; App Manager role is enough.

Flags: `--key <AuthKey_X.p8>`, `--key-id`, `--issuer`. For CI, skip init and set `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY` (the .p8 contents) or `ASC_KEY_PATH`.

## status

```sh
ascship status              # the app in ascship.yaml
ascship status --app com.example.other --json
```

Live version, the version in progress, open review submissions and recent builds, and what is stuck:

- A rejected submission still open (`UNRESOLVED_ISSUES`), with the exact call to cancel it and resubmit the same build after a backend-only fix.
- A draft submission that was never submitted (it blocks creating a new one).
- A version in progress with no build, or a newer build than the one attached or in review.
- Export compliance blocking review; approved versions waiting for you to release them; builds that failed processing.
- App Privacy is not exposed by the API, so for a version being prepared, status reminds you to confirm it is Published.

Exit code 1 when something needs attention.

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
