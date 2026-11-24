package dev.yarvis.android.api

import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient

internal fun json(code: Int, body: String): MockResponse =
    MockResponse.Builder().code(code).setHeader("Content-Type", "application/json").body(body).build()

internal fun sse(vararg frames: String): MockResponse = MockResponse.Builder()
    .setHeader("Content-Type", "text/event-stream")
    .body(frames.joinToString("") { "data: $it\n\n" })
    .build()

/** Waits for the next request, failing instead of hanging if none comes. */
internal fun MockWebServer.next(): RecordedRequest =
    takeRequest(5, TimeUnit.SECONDS) ?: error("no request arrived")

internal val RecordedRequest.text: String get() = body?.utf8().orEmpty()

internal val testHttp: OkHttpClient = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
