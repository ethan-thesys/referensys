# Publishing an update

Installed copies of Referensys check `github.com/ethan-thesys/referensys` for the newest **published release** and update themselves from it.

1. Raise `"version"` in `package.json` (for example 1.0.0 → 1.0.1). Installed copies only update when this number goes up.
2. Build on Linux (needs Wine, including the 32-bit part) or on Windows:

   ```
   npm install
   npx electron-builder --win nsis --x64 --publish never
   ```

3. Create a GitHub release on `ethan-thesys/referensys`:
   - Tag: `v` + the version, for example `v1.0.1`
   - Attach all three files from `dist/`:
     - `Referensys-Setup-<version>.exe`
     - `Referensys-Setup-<version>.exe.blockmap`
     - `latest.yml`
   - Publish it. Don't leave it as a draft, and don't mark it as a pre-release.

Every installed copy picks the update up the next time it opens, or within four hours if it's already open.

The repository holds only the app. Recordings, screenshots and PDFs are never uploaded anywhere.
