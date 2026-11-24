package dev.yarvis.android.ui

import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.ApiException
import dev.yarvis.android.api.LoginRequest
import dev.yarvis.android.api.UnauthorizedException
import dev.yarvis.android.ui.signin.SignInGateway
import dev.yarvis.android.ui.signin.SignInViewModel
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SignInViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private class FakeGateway : SignInGateway {
        var setupRequired = false
        var error: Exception? = null
        val signIns = mutableListOf<Pair<HttpUrl, LoginRequest>>()
        override suspend fun isSetupRequired(server: HttpUrl) = setupRequired
        override suspend fun signIn(server: HttpUrl, request: LoginRequest) {
            error?.let { throw it }
            signIns += server to request
        }
        override val defaultDeviceName = "Pixel 10"
    }

    private val gateway = FakeGateway()

    private fun filled(vm: SignInViewModel, server: String = "yarvis.tail1.ts.net", backup: Boolean = false) =
        vm.update { it.copy(server = server, passphrase = "correct horse", code = " 123456 ", useBackupCode = backup) }

    @Test
    fun `signs in over https with the code and the default device name`() = runTest {
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm)
        vm.submit()
        advanceUntilIdle()

        val (url, request) = gateway.signIns.single()
        assertEquals("https://yarvis.tail1.ts.net/", url.toString())
        assertEquals(LoginRequest("correct horse", code = "123456", deviceName = "Pixel 10"), request)
        assertEquals("", vm.state.value.passphrase)
    }

    @Test
    fun `a backup code goes in backupCode`() = runTest {
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm, backup = true)
        vm.submit()
        advanceUntilIdle()

        val request = gateway.signIns.single().second
        assertNull(request.code)
        assertEquals("123456", request.backupCode)
    }

    @Test
    fun `an http address is refused before anything is sent`() = runTest {
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm, server = "http://yarvis.local:8787")
        vm.submit()
        advanceUntilIdle()

        assertTrue(gateway.signIns.isEmpty())
        assertTrue(vm.state.value.error!!.contains("https"))
    }

    @Test
    fun `a server that isn't set up points to the web UI`() = runTest {
        gateway.setupRequired = true
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm)
        vm.submit()
        advanceUntilIdle()

        assertTrue(gateway.signIns.isEmpty())
        assertTrue(vm.state.value.error!!.contains("web UI"))
        assertFalse(vm.state.value.busy)
    }

    @Test
    fun `wrong credentials clear the code and say so`() = runTest {
        gateway.error = UnauthorizedException("wrong passphrase or code")
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm)
        vm.submit()
        advanceUntilIdle()

        assertEquals("Wrong passphrase or code.", vm.state.value.error)
        assertEquals("", vm.state.value.code)
    }

    @Test
    fun `too many tries says to wait`() = runTest {
        gateway.error = ApiException(429, "too many failed sign-ins", "try again in 5 minutes")
        val vm = SignInViewModel(gateway, lastServerUrl = null)
        filled(vm)
        vm.submit()
        advanceUntilIdle()

        assertTrue(vm.state.value.error!!.startsWith("Too many tries"))
    }

    @Test
    fun `the last server is prefilled`() {
        val vm = SignInViewModel(gateway, lastServerUrl = "https://yarvis.tail1.ts.net/")
        assertEquals("https://yarvis.tail1.ts.net", vm.state.value.server)
    }
}
