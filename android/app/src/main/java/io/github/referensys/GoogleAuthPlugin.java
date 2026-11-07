package io.github.referensys;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Google sign-in for Drive. The person picks an account, then Google asks them to allow
 * Referensys's two Drive permissions. Returns a short-lived access token; Referensys asks again
 * (without showing anything) when it needs a fresh one.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {
    private static final List<Scope> SCOPES = Arrays.asList(
            new Scope("https://www.googleapis.com/auth/drive.file"),
            new Scope("https://www.googleapis.com/auth/drive.appdata"),
            new Scope("email"));

    private ActivityResultLauncher<Intent> pickLauncher;
    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    private PluginCall waiting;
    private String waitingEmail;

    @Override public void load() {
        pickLauncher = getActivity().getActivityResultRegistry().register("referensys-pick",
                new ActivityResultContracts.StartActivityForResult(), this::onPicked);
        consentLauncher = getActivity().getActivityResultRegistry().register("referensys-consent",
                new ActivityResultContracts.StartIntentSenderForResult(), this::onConsent);
    }

    /** Shows Android's account chooser, then asks for Drive access on the chosen account. */
    @PluginMethod public void signIn(PluginCall call) {
        if (waiting != null) { call.reject("Sign-in is already open.", "busy"); return; }
        waiting = call;
        Intent i = AccountManager.newChooseAccountIntent(null, null, new String[]{"com.google"}, null, null, null, null);
        getActivity().runOnUiThread(() -> pickLauncher.launch(i));
    }

    private void onPicked(ActivityResult res) {
        PluginCall c = waiting;
        if (c == null) return;
        Intent d = res.getData();
        String email = d == null ? null : d.getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
        if (res.getResultCode() != Activity.RESULT_OK || email == null) { waiting = null; c.reject("Sign-in was cancelled.", "denied"); return; }
        authorize(c, email, true);
    }

    /** Gets an access token for an account that's already signed in. Shows nothing unless interactive is true. */
    @PluginMethod public void getToken(PluginCall call) {
        String email = call.getString("email");
        if (email == null) { call.reject("No account.", "signed_out"); return; }
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        if (interactive) {
            if (waiting != null) { call.reject("Sign-in is already open.", "busy"); return; }
            waiting = call;
        }
        authorize(call, email, interactive);
    }

    private void authorize(PluginCall call, String email, boolean interactive) {
        AuthorizationRequest req = AuthorizationRequest.builder()
                .setRequestedScopes(SCOPES)
                .setAccount(new Account(email, "com.google"))
                .build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
                .addOnSuccessListener(ar -> {
                    if (ar.hasResolution()) {
                        if (!interactive || ar.getPendingIntent() == null) { finish(call, null); call.reject("Sign in again to allow Referensys to use Google Drive.", "reauth"); return; }
                        waitingEmail = email;
                        try {
                            consentLauncher.launch(new IntentSenderRequest.Builder(ar.getPendingIntent().getIntentSender()).build());
                        } catch (Exception e) {
                            finish(call, null);
                            call.reject("Couldn't open Google's sign-in screen.", "auth");
                        }
                    } else {
                        resolve(call, email, ar);
                    }
                })
                .addOnFailureListener(e -> { finish(call, null); call.reject("Google sign-in failed: " + e.getMessage(), "auth"); });
    }

    private void onConsent(ActivityResult res) {
        PluginCall c = waiting;
        String email = waitingEmail;
        if (c == null) return;
        if (res.getResultCode() != Activity.RESULT_OK) { finish(c, null); c.reject("Sign-in was cancelled.", "denied"); return; }
        try {
            AuthorizationResult ar = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(res.getData());
            resolve(c, email, ar);
        } catch (Exception e) {
            finish(c, null);
            c.reject("Google sign-in failed: " + e.getMessage(), "auth");
        }
    }

    private void resolve(PluginCall call, String email, AuthorizationResult ar) {
        finish(call, null);
        List<String> granted = new ArrayList<>();
        granted.addAll(ar.getGrantedScopes());
        if (!granted.contains("https://www.googleapis.com/auth/drive.file") || !granted.contains("https://www.googleapis.com/auth/drive.appdata")) {
            call.reject("Referensys needs both permissions on Google's screen. Sign in again and leave both boxes ticked.", "scopes");
            return;
        }
        JSObject o = new JSObject();
        o.put("email", email);
        o.put("accessToken", ar.getAccessToken());
        o.put("scopes", new JSArray(granted));
        call.resolve(o);
    }

    private void finish(PluginCall call, Object unused) {
        if (waiting == call) { waiting = null; waitingEmail = null; }
    }

    /** Forgets a token Google has rejected, so the next request gets a fresh one. */
    @PluginMethod public void clearToken(PluginCall call) {
        String t = call.getString("token");
        new Thread(() -> {
            try { if (t != null) GoogleAuthUtil.clearToken(getContext(), t); } catch (Exception ignored) {}
            call.resolve();
        }).start();
    }
}
