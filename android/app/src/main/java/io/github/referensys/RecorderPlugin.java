package io.github.referensys;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Lets the Referensys screens start tap recording, receive the steps, and install app updates. */
@CapacitorPlugin(name = "Recorder")
public class RecorderPlugin extends Plugin {
    private static RecorderPlugin current;
    private static String pending;

    @Override public void load() {
        current = this;
        flush();
    }

    @Override protected void handleOnResume() {
        super.handleOnResume();
        flush();
    }

    /** Called by the recorder when Done is tapped. Kept until the screens are ready to take it. */
    static void deliver(String json) {
        pending = json;
        if (current != null) current.flush();
    }

    private void flush() {
        if (pending == null) return;
        JSObject o = new JSObject();
        o.put("steps", pending);
        pending = null;
        notifyListeners("recorded", o, true);
    }

    private boolean enabled() {
        String s = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        return s != null && s.contains(getContext().getPackageName() + "/");
    }

    @PluginMethod public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("enabled", enabled() && RecorderService.instance != null);
        RecorderService s = RecorderService.instance;
        r.put("recording", s != null && s.isRecording());
        call.resolve(r);
    }

    @PluginMethod public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod public void start(PluginCall call) {
        RecorderService s = RecorderService.instance;
        if (s == null || !enabled()) { call.reject("Tap recording is switched off.", "permission"); return; }
        s.startRecording(Boolean.TRUE.equals(call.getBoolean("screenText", true)));
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
    }

    @PluginMethod public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", p.versionName);
        } catch (Exception e) {
            r.put("version", "");
        }
        call.resolve(r);
    }

    @PluginMethod public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("Not a web link."); return; }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ---------- updates ----------
    @PluginMethod public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod public void openInstallSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod public void downloadUpdate(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("No download link."); return; }
        call.setKeepAlive(false);
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File f = new File(dir, "referensys-update.apk");
                URL u = new URL(url);
                for (int hops = 0; hops < 5; hops++) { // GitHub sends release files from another address
                    c = (HttpURLConnection) u.openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(30000);
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) { u = new URL(u, c.getHeaderField("Location")); c.disconnect(); continue; }
                    if (code != 200) throw new Exception("The download failed (HTTP " + code + ").");
                    break;
                }
                long total = c.getContentLengthLong(), got = 0;
                int lastPct = -1;
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                JSObject p = new JSObject();
                                p.put("percent", pct);
                                notifyListeners("updateProgress", p);
                            }
                        }
                    }
                }
                JSObject r = new JSObject();
                r.put("path", f.getAbsolutePath());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "The download failed." : e.getMessage(), "download");
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    @PluginMethod public void installUpdate(PluginCall call) {
        try {
            File f = new File(getContext().getCacheDir(), "updates/referensys-update.apk");
            if (!f.exists()) { call.reject("The update isn't downloaded yet."); return; }
            Uri u = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(u, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Couldn't open the installer." : e.getMessage());
        }
    }
}
