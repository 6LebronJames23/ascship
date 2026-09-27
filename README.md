# ascship

Ship iOS apps from the terminal with one App Store Connect API key. From signing to submission: `init`, `profile`, `build`, `listing`, `submit`, plus `status` and `doctor`.

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

## The release flow

```sh
ascship init --app com.example.myapp      # once
ascship profile                            # once, and when certificates change
ascship listing pull                       # listing text into ascship.yaml
ascship build --upload                     # archive, export, doctor, upload
ascship listing push                       # after editing ascship.yaml
ascship submit --app-version 1.4           # create the version, attach the build, submit
ascship status                             # until it is live
```

Every command that changes App Store Connect supports `--dry-run`, and `listing push` / `submit` ask before they act (`--yes` to skip, required without a terminal).

## profile

```sh
ascship profile                  # app-store profiles for every target in project.yml
ascship profile --type development --bundle-id com.example.myapp
```

Makes sure every bundle (app, extensions, watch app) has an active profile signed by a certificate **whose private key is in this Mac's keychain** (matched by serial, not just "the first distribution certificate"). Reuses a valid profile, otherwise registers the bundle id if needed and creates a new, uniquely named profile. Installs them and records the mapping in `ascship.yaml`. **It never deletes profiles**, so it can't break another app that shares a name. Works without an Apple ID signed in to Xcode.

## build

```sh
ascship build --dry-run          # print the xcodebuild commands and ExportOptions.plist
ascship build                    # archive + export + doctor
ascship build --upload           # ...and upload if doctor passes
```

Refuses to archive when `project.yml` is ahead of the generated project (`--regenerate` runs xcodegen first). Exports with manual signing using the profiles from `ascship profile`, with `manageAppVersionAndBuildNumber` off so Xcode can't renumber your build. Runs `doctor` on the exported IPA and uploads only a clean build, with `altool` and your API key. Logs go to `build/ascship/logs/`.

## listing

```sh
ascship listing pull             # live / in-progress listing → ascship.yaml
ascship listing push --dry-run   # show the diff
ascship listing push             # check, confirm, update only what changed
```

Name, subtitle and privacy URL go to the app info; description, keywords, promotional text, What's New and support/marketing URLs go to the version in progress. Runs the doctor listing checks first and refuses to push text App Store Connect would reject. Skips What's New on a first release (not allowed) and creates localizations that don't exist yet.

## submit

```sh
ascship submit --dry-run
ascship submit --app-version 1.4 --release manual
ascship submit --cancel          # withdraw a submission
```

Creates the version if needed, attaches the newest processed build for that version, and checks what App Review will see: description, What's New on updates, screenshots in every localization, and no emoji. Export compliance must be answered explicitly (`--no-encryption` for apps that only use standard HTTPS). Reuses an unsubmitted draft submission rather than hitting the one-draft limit, and refuses while another submission is in review or rejected (use `--cancel`).

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
