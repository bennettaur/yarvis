package dev.yarvis.android.lock

import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class LockState { Loading, Locked, Unlocked }

/** Whether the user wants the lock. Null means they never chose, which counts as on. */
interface LockPrefs {
    suspend fun lockEnabled(): Boolean?
    suspend fun saveLockEnabled(enabled: Boolean)
}

/** Time away the app allows before it asks again, so a quick app switch doesn't. */
const val LOCK_GRACE_MS = 60 * 1000L

/**
 * Locks the app on launch, and again after [graceMs] in the background, until
 * the user passes the device's biometric or screen-lock check. A device with no
 * screen lock has nothing to check against, so it never locks.
 */
class AppLock(
    private val prefs: LockPrefs,
    /** True when the device has a fingerprint, face or screen lock to check. */
    private val canAuthenticate: () -> Boolean,
    private val scope: CoroutineScope,
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val graceMs: Long = LOCK_GRACE_MS,
) {
    private val _state = MutableStateFlow(LockState.Loading)
    val state: StateFlow<LockState> = _state.asStateFlow()

    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private var backgroundedAt: Long? = null

    // The screen-lock check is its own activity, so passing it sends the app to the
    // background and back. That trip must not count as leaving.
    private var authenticating = false
    private var autoPrompted = false

    init {
        scope.launch {
            val on = prefs.lockEnabled() ?: true
            _enabled.value = on
            _state.value = if (on && canAuthenticate()) LockState.Locked else LockState.Unlocked
        }
    }

    fun onBackground() {
        if (!authenticating) backgroundedAt = now()
    }

    fun onForeground() {
        val since = backgroundedAt ?: return
        backgroundedAt = null
        if (!authenticating && _enabled.value && now() - since >= graceMs) lock()
    }

    /**
     * True once per lock, so the prompt opens by itself only the first time.
     * After the user cancels it, they reopen it from the lock screen.
     */
    fun takeAutoPrompt(): Boolean {
        if (_state.value != LockState.Locked || autoPrompted || authenticating) return false
        autoPrompted = true
        return true
    }

    fun promptShown() {
        authenticating = true
    }

    fun promptEnded(passed: Boolean) {
        authenticating = false
        if (passed) _state.value = LockState.Unlocked
    }

    /** Signing in just proved who the user is, so it opens the app as a pass would. */
    fun signedIn() {
        _state.value = LockState.Unlocked
    }

    /** Turning the lock on needs something to check against; see [canAuthenticate]. */
    fun setEnabled(on: Boolean) {
        if (on && !canAuthenticate()) return
        _enabled.value = on
        scope.launch { prefs.saveLockEnabled(on) }
    }

    private fun lock() {
        // A screen lock removed while the app was away leaves nothing to unlock with.
        if (!canAuthenticate()) return
        autoPrompted = false
        _state.value = LockState.Locked
    }
}
