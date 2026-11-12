//! Reading files the user picked through Android's system file picker.
//!
//! The picker hands back `content://` URIs rather than paths: the app has no
//! filesystem access to other apps' files under scoped storage, only a
//! per-URI grant that goes through `ContentResolver`. This module resolves
//! such a URI to its display name and an open file descriptor via JNI, so
//! the rest of the backend can treat it as an ordinary `std::fs::File`.

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;
use std::fs::File;
use std::os::fd::FromRawFd;

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// Open a picked `content://` URI for reading. Returns the provider's display
/// name (if it reports one) and a file owning a detached descriptor.
pub fn open_content_uri(uri: &str) -> Result<(Option<String>, File), String> {
    let ctx = ndk_context::android_context();
    // SAFETY: Tauri initialises ndk-context with the process's JavaVM and a
    // live Context before any command can run; both outlive this call.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(err("JavaVM unavailable"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm.attach_current_thread().map_err(err("JNI attach failed"))?;

    let result = (|| -> jni::errors::Result<(Option<String>, i32)> {
        let uri_string = env.new_string(uri)?;
        let juri = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&uri_string)],
            )?
            .l()?;
        let resolver = env
            .call_method(&context, "getContentResolver", "()Landroid/content/ContentResolver;", &[])?
            .l()?;

        // Display name: query the OpenableColumns.DISPLAY_NAME column.
        let null = JObject::null();
        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    JValue::Object(&juri),
                    JValue::Object(&null),
                    JValue::Object(&null),
                    JValue::Object(&null),
                    JValue::Object(&null),
                ],
            )?
            .l()?;
        let mut name = None;
        if !cursor.is_null() {
            if env.call_method(&cursor, "moveToFirst", "()Z", &[])?.z()? {
                let column = env.new_string("_display_name")?;
                let index = env
                    .call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&column)])?
                    .i()?;
                if index >= 0 {
                    let value = env
                        .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(index)])?
                        .l()?;
                    if !value.is_null() {
                        name = Some(env.get_string(&JString::from(value))?.into());
                    }
                }
            }
            env.call_method(&cursor, "close", "()V", &[])?;
        }

        // Contents: a read-only ParcelFileDescriptor, detached so Rust owns the fd.
        let mode = env.new_string("r")?;
        let pfd = env
            .call_method(
                &resolver,
                "openFileDescriptor",
                "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
                &[JValue::Object(&juri), JValue::Object(&mode)],
            )?
            .l()?;
        if pfd.is_null() {
            return Err(jni::errors::Error::NullPtr("openFileDescriptor returned null"));
        }
        let fd = env.call_method(&pfd, "detachFd", "()I", &[])?.i()?;
        Ok((name, fd))
    })();

    match result {
        Ok((name, fd)) => {
            // SAFETY: `detachFd` transferred ownership of a valid descriptor to us.
            Ok((name, unsafe { File::from_raw_fd(fd) }))
        }
        Err(e) => {
            // A pending Java exception (e.g. SecurityException for a revoked
            // grant) must be cleared or the next JNI call on this thread aborts.
            if env.exception_check().unwrap_or(false) {
                let _ = env.exception_clear();
            }
            Err(format!("Cannot open the selected file: {e}"))
        }
    }
}
