package dev.yarvis.android.ui.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.ApiException
import dev.yarvis.android.api.LoginRequest
import dev.yarvis.android.api.ServerUrl
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

interface SignInGateway {
    suspend fun setupRequired(server: HttpUrl): Boolean

    /** Signs in, keeps the token, and moves the app to the signed-in screens. */
    suspend fun signIn(server: HttpUrl, request: LoginRequest)

    val defaultDeviceName: String
}

data class SignInState(
    val server: String = "",
    val passphrase: String = "",
    val code: String = "",
    val useBackupCode: Boolean = false,
    val deviceName: String = "",
    val busy: Boolean = false,
    val error: String? = null,
) {
    val canSubmit: Boolean
        get() = !busy && server.isNotBlank() && passphrase.isNotEmpty() && code.isNotBlank() && deviceName.isNotBlank()
}

class SignInViewModel(private val gateway: SignInGateway, lastServerUrl: String?) : ViewModel() {
    private val _state = MutableStateFlow(
        SignInState(server = lastServerUrl?.trimEnd('/').orEmpty(), deviceName = gateway.defaultDeviceName),
    )
    val state: StateFlow<SignInState> = _state.asStateFlow()

    fun update(transform: (SignInState) -> SignInState) = _state.update { transform(it).copy(error = null) }

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        val server = ServerUrl.parse(s.server).getOrElse { e ->
            _state.update { it.copy(error = e.message) }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                if (gateway.setupRequired(server)) {
                    _state.update {
                        it.copy(busy = false, error = "This server isn't set up yet. Finish setup in the web UI first.")
                    }
                    return@launch
                }
                val code = s.code.trim()
                gateway.signIn(
                    server,
                    LoginRequest(
                        passphrase = s.passphrase,
                        code = code.takeUnless { s.useBackupCode },
                        backupCode = code.takeIf { s.useBackupCode },
                        deviceName = s.deviceName.trim(),
                    ),
                )
                _state.update { it.copy(busy = false, passphrase = "", code = "") }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _state.update { it.copy(busy = false, code = "", error = signInError(e)) }
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, error = "Couldn't reach the server: ${e.message}") }
            }
        }
    }

    private fun signInError(e: ApiException): String = when (e.status) {
        401 -> "Wrong passphrase or code."
        429 -> "Too many tries. Wait a minute and try again."
        else -> e.message ?: "Sign-in failed (${e.status})."
    }
}
