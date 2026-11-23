package dev.yarvis.android.api

import java.io.IOException
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Response

val YarvisJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

/** A non-2xx answer, carrying the server's `{ error, detail }` body. */
open class ApiException(
    val status: Int,
    val error: String?,
    val detail: String? = null,
) : IOException(listOfNotNull(error ?: "HTTP $status", detail).joinToString(": ")) {
    /** A fresh-only route refused a device that hasn't confirmed a code recently. */
    val isReauthRequired: Boolean get() = status == 403 && error == REAUTH_REQUIRED

    companion object {
        const val REAUTH_REQUIRED = "reauth_required"
    }
}

/** No token, or one that's unknown, revoked or expired. The app goes back to sign-in. */
class UnauthorizedException(error: String? = null) : ApiException(401, error)

/** The user closed the code prompt instead of confirming. */
class ReauthCancelledException : IOException("cancelled")

internal fun Response.toApiException(): ApiException {
    val raw = runCatching { body.string() }.getOrNull()
    val parsed = raw?.let { runCatching { YarvisJson.decodeFromString(ErrorBody.serializer(), it) }.getOrNull() }
    val error = parsed?.message ?: raw?.takeIf { it.isNotBlank() && it.length < 200 }
    return if (code == 401) UnauthorizedException(error) else ApiException(code, error, parsed?.detail)
}

/** Runs the call without blocking, and cancels it when the coroutine is cancelled. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
}

object ServerUrl {
    /**
     * Turns what the user typed into the server's origin. HTTPS only: the device
     * token rides on every request. A bare host such as `yarvis.tailnet.ts.net`
     * gets `https://`.
     */
    fun parse(input: String): Result<HttpUrl> {
        val trimmed = input.trim().trimEnd('/')
        if (trimmed.isEmpty()) return Result.failure(IllegalArgumentException("Enter the server's address."))
        val withScheme = if ("://" in trimmed) trimmed else "https://$trimmed"
        val url = withScheme.toHttpUrlOrNull()
            ?: return Result.failure(IllegalArgumentException("That isn't a valid address."))
        if (url.scheme != "https") {
            return Result.failure(IllegalArgumentException("Use an https:// address, such as the one tailscale serve gives."))
        }
        return Result.success(url.newBuilder().encodedPath("/").query(null).fragment(null).build())
    }
}
