//! Start/stop the Android foreground service that keeps the process (and so
//! every SSH/SFTP/tunnel socket) alive while the app is in the background.
//!
//! Without it Android freezes the backgrounded process after about a minute
//! and the sessions drop. The service itself lives in the Android project:
//! `gen/android/app/src/main/java/com/termimus/app/SessionKeepAliveService.kt`.

use jni::objects::{JObject, JValue};
use jni::JavaVM;

const SERVICE_CLASS: &str = "com.termimus.app.SessionKeepAliveService";
/// `Build.VERSION_CODES.O`: first release with `startForegroundService`.
const API_O: i32 = 26;

/// Intent extras carrying the notification's text; must match
/// `SessionKeepAliveService.EXTRA_TITLE` / `EXTRA_SUMMARY`.
const EXTRA_TITLE: &str = "title";
const EXTRA_SUMMARY: &str = "summary";

/// Turn the keep-alive service on or off. Safe to call repeatedly: starting
/// an already-running service re-delivers the intent, which is how the
/// notification text gets refreshed. `title` and `summary` come from the
/// frontend so they follow the language chosen in the app, not the device's.
pub fn set_active(active: bool, title: Option<&str>, summary: Option<&str>) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    // SAFETY: Tauri initialises ndk-context with the process's JavaVM and a
    // live Context before any command can run; both outlive this call.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JavaVM unavailable: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm.attach_current_thread().map_err(|e| format!("JNI attach failed: {e}"))?;

    let result = (|| -> jni::errors::Result<()> {
        // Address the service by name: `FindClass` on a native thread cannot
        // see app classes, but `Intent.setClassName` only needs strings.
        let intent = env.new_object("android/content/Intent", "()V", &[])?;
        let class_name = env.new_string(SERVICE_CLASS)?;
        env.call_method(
            &intent,
            "setClassName",
            "(Landroid/content/Context;Ljava/lang/String;)Landroid/content/Intent;",
            &[JValue::Object(&context), JValue::Object(&class_name)],
        )?;

        if !active {
            env.call_method(&context, "stopService", "(Landroid/content/Intent;)Z", &[JValue::Object(&intent)])?;
            return Ok(());
        }

        for (name, text) in [(EXTRA_TITLE, title), (EXTRA_SUMMARY, summary)] {
            let Some(text) = text.filter(|s| !s.is_empty()) else { continue };
            let key = env.new_string(name)?;
            let value = env.new_string(text)?;
            env.call_method(
                &intent,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[JValue::Object(&key), JValue::Object(&value)],
            )?;
        }

        let sdk = env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()?;
        let start = if sdk >= API_O { "startForegroundService" } else { "startService" };
        env.call_method(
            &context,
            start,
            "(Landroid/content/Intent;)Landroid/content/ComponentName;",
            &[JValue::Object(&intent)],
        )?;
        Ok(())
    })();

    result.map_err(|e| {
        // A pending Java exception (e.g. the system refusing a background
        // start) must be cleared or the next JNI call on this thread aborts.
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        format!("Could not {} the keep-alive service: {e}", if active { "start" } else { "stop" })
    })
}
