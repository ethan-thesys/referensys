package io.github.referensys;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.HardwareBuffer;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Records taps in other apps while the person is recording an SOP.
 * Android only lets an app see taps elsewhere through an accessibility service, so this is one.
 * It does nothing until Record is pressed in Referensys, and stops when Done is pressed.
 *
 * A screenshot is taken about twice a second while recording, so each step can use the screen as it
 * looked just before the tap. Screenshots stay in memory until the person taps Done.
 */
public class RecorderService extends AccessibilityService {
    static volatile RecorderService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private volatile boolean recording = false;
    private volatile boolean paused = false;
    private boolean useText = true;
    private JSONArray steps = new JSONArray();

    /** The most recent screenshot, already scaled down. */
    private static final class Shot { Bitmap bmp; float scale; }
    private volatile Shot last;
    private static final float MAX_W = 1080f;

    private WindowManager wm;
    private LinearLayout bubble, menu;
    private TextView dot, status, pauseBtn;

    @Override protected void onServiceConnected() {
        instance = this;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    }

    @Override public boolean onUnbind(Intent intent) {
        main.post(() -> { if (recording) finish(); });
        instance = null;
        return super.onUnbind(intent);
    }

    @Override public void onInterrupt() {}

    boolean isRecording() { return recording; }

    void startRecording(boolean screenText) {
        main.post(() -> {
            if (recording) return;
            steps = new JSONArray();
            useText = screenText;
            paused = false;
            recording = true;
            showBubble();
            main.post(loop);
        });
    }

    // ---------- screenshots ----------
    private final Runnable loop = new Runnable() {
        @Override public void run() {
            if (!recording) return;
            shoot();
            main.postDelayed(this, 450); // Android allows about three screenshots a second
        }
    };

    private void shoot() {
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, work, new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    HardwareBuffer hb = r.getHardwareBuffer();
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                        if (hw == null) return;
                        Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, true);
                        hw.recycle();
                        if (sw == null) return;
                        float s = Math.min(1f, MAX_W / sw.getWidth());
                        Bitmap out = sw;
                        if (s < 1f) {
                            out = Bitmap.createScaledBitmap(sw, Math.round(sw.getWidth() * s), Math.round(sw.getHeight() * s), true);
                            sw.recycle();
                        }
                        Shot shot = new Shot();
                        shot.bmp = out;
                        shot.scale = s;
                        last = shot;
                    } catch (Throwable t) {
                        // Ignore one bad frame; the next one comes in under half a second.
                    } finally {
                        hb.close();
                    }
                }
                @Override public void onFailure(int errorCode) {}
            });
        } catch (Throwable t) {
            // Screenshot not available right now (for example the screen is off).
        }
    }

    // ---------- taps ----------
    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (!recording || paused || e == null) return;
        if (e.getEventType() != AccessibilityEvent.TYPE_VIEW_CLICKED) return;
        CharSequence pkg = e.getPackageName();
        if (pkg != null && pkg.toString().equals(getPackageName())) return; // our own bubble or app
        final Shot shot = last;
        if (shot == null) return;

        Rect b = new Rect();
        String label = "", role = "";
        AccessibilityNodeInfo n = e.getSource();
        if (n != null) {
            n.getBoundsInScreen(b);
            role = roleOf(n);
            if (useText) label = labelOf(n);
        }
        final String app = appName(pkg);
        final Rect bounds = b, hide = bubbleRect();
        final String fLabel = label, fRole = role;

        work.execute(() -> {
            try {
                Bitmap img = shot.bmp.copy(Bitmap.Config.ARGB_8888, true);
                float s = shot.scale;
                // Paint over the floating bubble so it doesn't appear in the step.
                if (hide != null) {
                    Rect h = new Rect(Math.round(hide.left * s), Math.round(hide.top * s), Math.round(hide.right * s), Math.round(hide.bottom * s));
                    h.intersect(0, 0, img.getWidth(), img.getHeight());
                    if (!h.isEmpty()) {
                        int sx = Math.max(0, h.left - 2), sy = Math.min(img.getHeight() - 1, Math.max(0, h.centerY()));
                        Paint p = new Paint();
                        p.setColor(img.getPixel(sx, sy));
                        new Canvas(img).drawRect(h, p);
                    }
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                img.compress(Bitmap.CompressFormat.JPEG, 88, out);
                JSONObject o = new JSONObject();
                o.put("image", "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                o.put("w", img.getWidth());
                o.put("h", img.getHeight());
                if (!bounds.isEmpty()) {
                    o.put("x", Math.round(bounds.exactCenterX() * s));
                    o.put("y", Math.round(bounds.exactCenterY() * s));
                }
                o.put("scale", s);
                o.put("label", fLabel);
                o.put("role", fRole);
                o.put("app", app);
                img.recycle();
                main.post(() -> { steps.put(o); refresh(); });
            } catch (Throwable t) {
                // Skip a step that couldn't be captured rather than stopping the recording.
            }
        });
    }

    private static String clean(CharSequence c) {
        if (c == null) return "";
        String s = c.toString().replaceAll("\\s+", " ").trim();
        return s.length() > 60 ? s.substring(0, 60).trim() : s;
    }

    private static String labelOf(AccessibilityNodeInfo n) {
        String s = clean(n.getText());
        if (s.isEmpty()) s = clean(n.getContentDescription());
        if (s.isEmpty()) s = clean(n.getHintText());
        if (s.isEmpty()) s = childText(n, 0);
        if (s.isEmpty() && n.getViewIdResourceName() != null) {
            String id = n.getViewIdResourceName();
            id = id.substring(id.indexOf('/') + 1).replace('_', ' ').trim();
            if (!id.matches(".*\\d.*") && id.length() > 1 && id.length() < 30) s = id.substring(0, 1).toUpperCase() + id.substring(1);
        }
        return s;
    }

    private static String childText(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 2) return "";
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null) continue;
            String s = clean(c.getText());
            if (s.isEmpty()) s = clean(c.getContentDescription());
            if (s.isEmpty()) s = childText(c, depth + 1);
            if (!s.isEmpty()) return s;
        }
        return "";
    }

    /** Uses the same role names as the Windows app so titles are written the same way. */
    private static String roleOf(AccessibilityNodeInfo n) {
        String c = n.getClassName() == null ? "" : n.getClassName().toString();
        if (c.endsWith("EditText") || n.isEditable()) return "Edit";
        if (c.endsWith("Switch") || c.endsWith("CheckBox") || c.endsWith("ToggleButton") || n.isCheckable() && !c.endsWith("RadioButton")) return "CheckBox";
        if (c.endsWith("RadioButton")) return "RadioButton";
        if (c.endsWith("Spinner")) return "ComboBox";
        if (c.contains("Tab")) return "TabItem";
        if (n.getCollectionItemInfo() != null) return "ListItem";
        if (c.endsWith("Button") || c.endsWith("ImageButton") || c.endsWith("ImageView") && n.isClickable()) return "Button";
        return "";
    }

    private String appName(CharSequence pkg) {
        if (pkg == null) return "";
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg.toString(), 0)).toString();
        } catch (Exception ex) {
            return "";
        }
    }

    // ---------- floating bubble ----------
    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView pill(String text, int bg, int fg) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(fg);
        t.setTextSize(15);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(dp(16), dp(10), dp(16), dp(10));
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(10));
        t.setBackground(d);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        t.setLayoutParams(lp);
        return t;
    }

    private void showBubble() {
        if (bubble != null || wm == null) return;
        Context c = this;
        bubble = new LinearLayout(c);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setGravity(Gravity.END);

        menu = new LinearLayout(c);
        menu.setOrientation(LinearLayout.VERTICAL);
        menu.setPadding(dp(10), dp(8), dp(10), dp(10));
        GradientDrawable mb = new GradientDrawable();
        mb.setColor(Color.parseColor("#10181c"));
        mb.setCornerRadius(dp(16));
        menu.setBackground(mb);
        menu.setVisibility(View.GONE);
        status = new TextView(c);
        status.setTextColor(Color.parseColor("#9fb3be"));
        status.setTextSize(13);
        menu.addView(status);
        pauseBtn = pill("Pause", Color.parseColor("#24323a"), Color.parseColor("#e8f0f4"));
        pauseBtn.setOnClickListener(v -> { paused = !paused; refresh(); });
        menu.addView(pauseBtn);
        TextView done = pill("Done", Color.parseColor("#34b3a7"), Color.parseColor("#031d1b"));
        done.setOnClickListener(v -> finish());
        menu.addView(done);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(dp(170), LinearLayout.LayoutParams.WRAP_CONTENT);
        mlp.bottomMargin = dp(8);
        bubble.addView(menu, mlp);

        dot = new TextView(c);
        dot.setGravity(Gravity.CENTER);
        dot.setTextColor(Color.WHITE);
        dot.setTextSize(16);
        dot.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable db = new GradientDrawable();
        db.setShape(GradientDrawable.OVAL);
        db.setColor(Color.parseColor("#10181c"));
        db.setStroke(dp(3), Color.parseColor("#f2711c"));
        dot.setBackground(db);
        dot.setElevation(dp(6));
        dot.setOnClickListener(v -> menu.setVisibility(menu.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        bubble.addView(dot, new LinearLayout.LayoutParams(dp(58), dp(58)));

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.END | Gravity.CENTER_VERTICAL;
        lp.x = dp(10);
        wm.addView(bubble, lp);
        refresh();
    }

    private void refresh() {
        if (dot == null) return;
        int n = steps.length();
        dot.setText(paused ? "II" : String.valueOf(n));
        dot.setAlpha(paused ? 0.6f : 1f);
        status.setText((paused ? "Paused" : "Recording") + " · " + n + (n == 1 ? " step" : " steps"));
        pauseBtn.setText(paused ? "Resume" : "Pause");
    }

    private Rect bubbleRect() {
        if (bubble == null) return null;
        int[] p = new int[2];
        bubble.getLocationOnScreen(p);
        return new Rect(p[0], p[1], p[0] + bubble.getWidth(), p[1] + bubble.getHeight());
    }

    private void hideBubble() {
        if (bubble != null && wm != null) {
            try { wm.removeView(bubble); } catch (Exception ignored) {}
        }
        bubble = null; menu = null; dot = null; status = null; pauseBtn = null;
    }

    /** Stops recording, hands the steps to Referensys and brings it back to the front. */
    void finish() {
        if (!recording) return;
        recording = false;
        main.removeCallbacks(loop);
        hideBubble();
        // Runs after any step still being saved, so none are lost.
        work.execute(() -> main.post(() -> {
            RecorderPlugin.deliver(steps.toString());
            last = null;
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            startActivity(i);
        }));
    }
}
