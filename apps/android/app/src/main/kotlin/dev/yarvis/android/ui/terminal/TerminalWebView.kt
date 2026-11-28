package dev.yarvis.android.ui.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Choreographer
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.util.Base64

/** What the page reports, delivered on the main thread. */
interface TerminalPageListener {
    fun onReady()
    fun onData(data: String)
    fun onBinary(data: String)
    fun onResize(cols: Int, rows: Int)
    fun onModes(appCursor: Boolean)
    fun onTap()
    fun onCrashed()
}

private const val ASSET_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
private const val PAGE_PATH = "/terminal/terminal.html"
private const val PAGE_URL = "https://$ASSET_HOST$PAGE_PATH"

/**
 * The WebView xterm.js runs in, locked to the bundled page: it loads only
 * `assets/terminal/` from the asset loader's host, reaches no network, and
 * navigates nowhere. The PTY socket and the device token never enter it.
 */
@SuppressLint("ViewConstructor")
class TerminalWebView(context: Context, private val listener: TerminalPageListener, private var fontSize: Int) :
    WebView(context), TerminalSink {
    private val batcher = OutputBatcher()
    private var ready = false
    private var flushScheduled = false
    private var destroyed = false
    private var loadedFontSize = fontSize

    // Set from the WebViewClient on the main thread, read on the bridge's own thread.
    @Volatile
    private var trustedPage = false

    init {
        setWebContentsDebuggingEnabled(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        configure()
        addJavascriptInterface(Bridge(), "YarvisBridge")
        webViewClient = Client(assetLoader(context))
        // Compose already shrinks this view above the keyboard. A WebView that saw the
        // keyboard's inset would shrink its own viewport by it again.
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, _ -> WindowInsetsCompat.CONSUMED }
        loadUrl("$PAGE_URL?fontSize=$fontSize")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure() = with(settings) {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        domStorageEnabled = false
        setGeolocationEnabled(false)
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
        setSupportZoom(false)
        builtInZoomControls = false
        cacheMode = WebSettings.LOAD_NO_CACHE
    }

    override fun reset() = queue { batcher.reset() }

    override fun write(bytes: ByteArray) = queue { batcher.write(bytes) }

    /** Applied once the page is ready, if it changed since the page was loaded. */
    fun setFontSize(size: Int) {
        fontSize = size
        if (ready) applyFontSize()
    }

    private fun applyFontSize() {
        if (fontSize == loadedFontSize) return
        loadedFontSize = fontSize
        evaluateJavascript("yarvis.setFontSize($fontSize)", null)
    }

    /** Raises the keyboard; the page focuses xterm's input on the same tap. */
    /**
     * True lets the keyboard compose words, which swipe typing needs. False makes
     * it send each key as it's typed, which suits a shell better.
     */
    var wordInput = true
        set(value) {
            if (field == value) return
            field = value
            context.getSystemService(InputMethodManager::class.java)?.restartInput(this)
        }

    fun showKeyboard() {
        requestFocus()
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(this, 0)
    }

    override fun destroy() {
        destroyed = true
        super.destroy()
    }

    /**
     * Gboard and friends compose whole words in a text field before committing,
     * which reaches a terminal as nothing, then a burst. A password field's
     * keyboard sends each key as it's typed and offers no suggestions.
     */
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val connection = super.onCreateInputConnection(outAttrs) ?: return null
        // Keyboards turn off swipe typing in password fields, so key mode alone uses one.
        if (!wordInput) {
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        return connection
    }

    private inline fun queue(change: () -> Unit) {
        change()
        if (!flushScheduled && !destroyed) {
            flushScheduled = true
            Choreographer.getInstance().postFrameCallback { flush() }
        }
    }

    // At most once a frame, so a catch-up of thousands of socket frames is a handful of page calls.
    private fun flush() {
        flushScheduled = false
        if (!ready || destroyed) return
        for (batch in batcher.drain()) {
            val script = when (batch) {
                OutputBatch.Reset -> "yarvis.reset()"
                is OutputBatch.Bytes -> "yarvis.write('${Base64.getEncoder().encodeToString(batch.bytes)}')"
            }
            evaluateJavascript(script, null)
        }
    }

    private fun pageReady() {
        ready = true
        applyFontSize()
        if (!batcher.isEmpty) queue {}
        listener.onReady()
    }

    private fun assetLoader(context: Context): WebViewAssetLoader {
        val assets = WebViewAssetLoader.AssetsPathHandler(context)
        // Scoped to the terminal folder, so the page can't read any other bundled asset.
        return WebViewAssetLoader.Builder()
            .addPathHandler("/terminal/") { path -> assets.handle("terminal/$path") }
            .build()
    }

    private inner class Client(private val loader: WebViewAssetLoader) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url
            if (url.scheme == "https" && url.host == ASSET_HOST) {
                loader.shouldInterceptRequest(url)?.let { return it }
            }
            return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            val uri = url?.let(Uri::parse)
            trustedPage = uri != null && uri.scheme == "https" && uri.host == ASSET_HOST && uri.path == PAGE_PATH
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            destroyed = true
            listener.onCrashed()
            return true
        }
    }

    /** Runs on the WebView's binder thread; everything is handed to the main thread. */
    private inner class Bridge {
        private val main = Handler(Looper.getMainLooper())

        private inline fun post(crossinline call: () -> Unit) {
            if (!trustedPage) return
            main.post { if (!destroyed) call() }
        }

        @JavascriptInterface
        fun onReady() = post { pageReady() }

        @JavascriptInterface
        fun onData(data: String) = post { listener.onData(data) }

        @JavascriptInterface
        fun onBinary(data: String) = post { listener.onBinary(data) }

        @JavascriptInterface
        fun onResize(cols: Int, rows: Int) = post { listener.onResize(cols, rows) }

        @JavascriptInterface
        fun onModes(appCursor: Boolean) = post { listener.onModes(appCursor) }

        @JavascriptInterface
        fun onTap() = post { listener.onTap() }
    }
}
