# Releasing an update

Updates are built and published by GitHub automatically.

1. Make the code changes.
2. Raise `"version"` in `package.json` (for example 1.0.1 → 1.0.2). Installed copies only update when this number goes up.
3. Push to the `main` branch of github.com/ethan-thesys/referensys.

GitHub then builds the Windows installer on its own computers (see the **Actions** tab, about 5–10 minutes) and publishes a release named `v<version>` with three files: `Referensys-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`.

Installed copies of Referensys check for updates a few seconds after opening and every 4 hours. They download the new version in the background and show **Update ready**. The update installs when you click **Restart and update**, or the next time Referensys closes.

To rebuild a release without changing the version, open the **Actions** tab, choose **Release**, then **Run workflow**.
