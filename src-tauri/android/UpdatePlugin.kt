// Leonote updating itself on Android (the APK from GitHub; Google Play's copy is updated by Play and has none of this).
// android.yml copies this file into the generated Android project, as app.leonote.UpdatePlugin, and adds the
// REQUEST_INSTALL_PACKAGES permission; src-tauri/src/apkupdate.rs registers it and calls it.
//
// The new APK is handed to Android's own installer in a session. On Android 12 and newer an app may update itself
// without asking (USER_ACTION_NOT_REQUIRED) once the user has let it install apps; Android still asks when it wants
// to, and always on older Android - then its "Update this app?" is shown. Android itself refuses an APK that is not
// app.leonote signed with the same key, so nothing else can be installed this way.
package app.leonote

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private val action = "app.leonote.UPDATE_STATUS"

    /** May Leonote install apps (the user's "Install unknown apps" switch for it)? */
    @Command
    fun canInstall(invoke: Invoke) {
        val ret = JSObject()
        ret.put("allowed", Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls())
        invoke.resolve(ret)
    }

    /** Android's page where the user lets Leonote install apps - only on the user's own click. */
    @Command
    fun askPermission(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= 26) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
        }
        invoke.resolve()
    }

    /** The downloaded APK to Android's installer. Leonote closes when it goes in; the next start is the new version. */
    @Command
    fun install(invoke: Invoke) {
        try {
            val file = File(invoke.parseArgs(InstallArgs::class.java).path)
            val installer = activity.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(activity.packageName)
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("leonote.apk", 0, file.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                // Android answers here: when it wants the user's yes, its "Update this app?" is shown
                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(c: Context, i: Intent) {
                        val status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                            @Suppress("DEPRECATION")
                            val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else i.getParcelableExtra(Intent.EXTRA_INTENT)
                            if (confirm != null) {
                                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                activity.startActivity(confirm)
                            }
                        } else {
                            try { activity.unregisterReceiver(this) } catch (_: Exception) {}
                        }
                    }
                }
                ContextCompat.registerReceiver(activity, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
                val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_UPDATE_CURRENT
                val pending = PendingIntent.getBroadcast(activity, id, Intent(action).setPackage(activity.packageName), flags)
                session.commit(pending.intentSender)
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Android could not take the update")
        }
    }
}
