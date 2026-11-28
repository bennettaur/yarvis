package dev.yarvis.android.lock

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppLockTest {
    private class Prefs(var saved: Boolean? = null) : LockPrefs {
        override suspend fun lockEnabled() = saved
        override suspend fun saveLockEnabled(enabled: Boolean) {
            saved = enabled
        }
    }

    private var clock = 0L
    private var secure = true

    private fun TestScope.lock(prefs: Prefs = Prefs()) =
        AppLock(prefs, canAuthenticate = { secure }, scope = backgroundScope, now = { clock }, graceMs = 1_000)

    @Test
    fun `locks on launch unless the user turned it off`() = runTest(UnconfinedTestDispatcher()) {
        assertEquals(LockState.Locked, lock().state.value)
        assertEquals(LockState.Unlocked, lock(Prefs(saved = false)).state.value)
    }

    @Test
    fun `never locks a phone with no screen lock`() = runTest(UnconfinedTestDispatcher()) {
        secure = false
        val lock = lock()
        assertEquals(LockState.Unlocked, lock.state.value)
        lock.onBackground()
        clock += 5_000
        lock.onForeground()
        assertEquals(LockState.Unlocked, lock.state.value)
    }

    @Test
    fun `locks again only after the grace in the background`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        lock.beginPrompt()
        lock.promptEnded(passed = true)
        assertEquals(LockState.Unlocked, lock.state.value)

        lock.onBackground()
        clock += 999
        lock.onForeground()
        assertEquals(LockState.Unlocked, lock.state.value)

        lock.onBackground()
        clock += 1_000
        lock.onForeground()
        assertEquals(LockState.Locked, lock.state.value)
    }

    @Test
    fun `the trip to the screen-lock check doesn't relock`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        lock.beginPrompt()
        lock.onBackground()
        clock += 30_000
        lock.onForeground()
        lock.promptEnded(passed = true)
        assertEquals(LockState.Unlocked, lock.state.value)
    }

    @Test
    fun `a failed check stays locked and prompts by itself only once`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        assertTrue(lock.takeAutoPrompt())
        lock.beginPrompt()
        lock.promptEnded(passed = false)
        assertEquals(LockState.Locked, lock.state.value)
        assertFalse(lock.takeAutoPrompt())
    }

    @Test
    fun `turning it on needs a screen lock, and the choice is saved`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = Prefs(saved = false)
        val lock = lock(prefs)
        secure = false
        lock.setEnabled(true)
        assertFalse(lock.enabled.value)
        secure = true
        lock.setEnabled(true)
        assertTrue(lock.enabled.value)
        assertEquals(true, prefs.saved)
    }

    @Test
    fun `turned off, it stops relocking`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = Prefs()
        val lock = lock(prefs)
        lock.signedIn()
        lock.setEnabled(false)
        assertEquals(false, prefs.saved)
        lock.onBackground()
        clock += 5_000
        lock.onForeground()
        assertEquals(LockState.Unlocked, lock.state.value)
    }

    @Test
    fun `each relock prompts by itself again`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        assertTrue(lock.takeAutoPrompt())
        lock.beginPrompt()
        lock.promptEnded(passed = true)
        assertFalse(lock.takeAutoPrompt())
        lock.onBackground()
        clock += 5_000
        lock.onForeground()
        assertTrue(lock.takeAutoPrompt())
    }

    @Test
    fun `a screen lock removed while away unlocks rather than stranding the user`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        secure = false
        assertFalse(lock.beginPrompt())
        assertEquals(LockState.Unlocked, lock.state.value)
        lock.onBackground()
        clock += 5_000
        lock.onForeground()
        assertEquals(LockState.Unlocked, lock.state.value)
    }

    @Test
    fun `a sign-in before the setting loads isn't overwritten`() = runTest {
        val lock = lock()
        assertEquals(LockState.Loading, lock.state.value)
        lock.signedIn()
        advanceUntilIdle()
        assertEquals(LockState.Unlocked, lock.state.value)
    }

    @Test
    fun `signing in unlocks`() = runTest(UnconfinedTestDispatcher()) {
        val lock = lock()
        lock.signedIn()
        assertEquals(LockState.Unlocked, lock.state.value)
    }
}
