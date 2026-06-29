---
name: cut-release
description: Cut a new release — bump the version, write release notes (docs/releases/vX.Y.Z.md), package the zip, tag, and publish a GitHub release with the zip attached. Use when the user wants to release or publish a new version to GitHub. Involves git push + gh release (outward-facing) — confirm before the push/publish steps.
---

# Cut a release

Orchestrates a versioned release. The actual push and `gh release` are **outward-facing** —
confirm with the user before running steps 5–6 (and 7).

## Steps

1. **Bump the version** in `manifest.json` (`"version"`). Use semver
   (patch = fixes, minor = features, major = breaking). This must match the zip filename.

2. **Write the release notes** → `docs/releases/v<version>.md`. Include:
   - a **metadata table** (date, tag, package, permission changes, privacy-policy status);
   - **What's new** (user-facing changes);
   - an **Under the hood** file-change table;
   - a **Chrome Web Store update** checklist — exactly what to change in the dashboard
     (which package to upload, whether permission justifications change, privacy-policy status,
     data-usage + remote-code answers, store-listing changes);
   - **Privacy policy**, **Verification**, and **Known limitations** sections.

3. **Package** the zip (see the `package-extension` skill):
   ```bash
   ./fetch-ocr.sh   # only if shipping OCR in the package
   ./build.sh       # -> dist/<name>-v<version>.zip (name from manifest, e.g. catsnip-v<version>.zip)
   ```
   Sanity-check the `unzip -l` output (manifest at root, no dev files; `lib/tesseract/*`
   present only if you intend to ship OCR).

4. **Commit** the version bump, the release notes, and any shipped changes:
   ```bash
   git add manifest.json docs/releases/v<version>.md   # + any code changes
   git commit -m "Release v<version>: <short summary>"
   ```

5. **Tag and push** (confirm first):
   ```bash
   git tag v<version>
   git push origin main
   git push origin v<version>
   ```
   `.gitattributes` `export-ignore` keeps the tag's auto-generated "Source code" archives free
   of dev/build tooling.

6. **Publish the GitHub release** (confirm first) — reuse the **What's new** section:
   ```bash
   gh release create v<version> dist/<name>-v<version>.zip \
     --title "Catsnip v<version>" \
     --notes "…paste the What's new section…"
   ```

7. **If privacy-relevant behavior changed** (new data accessed, new permission, new flow),
   update the privacy-policy gist too — the release notes' **Chrome Web Store update** section
   should flag whether this is needed.

## Notes

- `gh` is authenticated as `artfred16`. Verify with `gh auth status` if a command fails.
- The same zip attached to the GitHub release is the artifact uploaded to the Chrome Web Store.
- End commit messages with the required `Co-Authored-By` trailer.
- Don't release with a `version` that's already tagged; check `git tag` / `gh release list` first.
