package dev.yarvis.android.lock

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi

/**
 * The device's own check: a strong fingerprint or face, falling back to the PIN,
 * pattern or password. Android 11 added a prompt that offers both; before that
 * the app asks for the screen lock, whose screen may offer a fingerprint itself.
 */
object DeviceAuth {
    @RequiresApi(Build.VERSION_CODES.R)
    private const val AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL

    fun canAuthenticate(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.getSystemService(BiometricManager::class.java)?.canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
        } else {
            context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
        }

    /** [onResult] runs on the main thread with whether the user passed. */
    @RequiresApi(Build.VERSION_CODES.R)
    fun prompt(context: Context, onResult: (Boolean) -> Unit) {
        val prompt = BiometricPrompt.Builder(context)
            .setTitle("Unlock Yarvis")
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        prompt.authenticate(
            CancellationSignal(),
            context.mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true)

                // A cancel, a lockout or too many tries. A single bad finger is
                // onAuthenticationFailed, which the prompt handles by letting the user retry.
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false)
            },
        )
    }

    /** Before Android 11: the screen-lock screen, launched for a result. Null when there is no screen lock. */
    @Suppress("DEPRECATION") // The replacement, BiometricPrompt's device credential, needs Android 11.
    fun screenLockIntent(context: Context): Intent? =
        context.getSystemService(KeyguardManager::class.java)?.createConfirmDeviceCredentialIntent("Unlock Yarvis", null)
}
