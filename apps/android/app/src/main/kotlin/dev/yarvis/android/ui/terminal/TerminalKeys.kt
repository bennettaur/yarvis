package dev.yarvis.android.ui.terminal

/** The keys a phone keyboard lacks, shown in a row above it. */
enum class ExtraKey(val label: String) {
    Esc("Esc"),
    Tab("Tab"),
    ShiftTab("⇧Tab"),
    Up("↑"),
    Down("↓"),
    Left("←"),
    Right("→"),
    CtrlC("^C"),
    Pipe("|"),
    Tilde("~"),
    Slash("/"),
    Dash("-"),
}

private const val ESC = "\u001b"

/** The bytes an xterm-compatible terminal sends for each key. */
object TerminalKeys {
    /**
     * [appCursor] is the terminal's DECCKM mode: full-screen programs such as
     * vim switch arrows to `ESC O A`, and the shell's line editor expects `ESC [ A`.
     */
    fun encode(key: ExtraKey, ctrl: Boolean, appCursor: Boolean): String = when (key) {
        ExtraKey.Esc -> ESC
        ExtraKey.Tab -> "\t"
        ExtraKey.ShiftTab -> "$ESC[Z"
        ExtraKey.Up -> arrow('A', ctrl, appCursor)
        ExtraKey.Down -> arrow('B', ctrl, appCursor)
        ExtraKey.Right -> arrow('C', ctrl, appCursor)
        ExtraKey.Left -> arrow('D', ctrl, appCursor)
        ExtraKey.CtrlC -> "\u0003"
        ExtraKey.Pipe -> typed("|", ctrl)
        ExtraKey.Tilde -> typed("~", ctrl)
        ExtraKey.Slash -> typed("/", ctrl)
        ExtraKey.Dash -> typed("-", ctrl)
    }

    /**
     * [text] as if typed with Ctrl held. Only the first character takes the
     * modifier, since a keyboard can commit several at once. Characters with no
     * control form pass through unchanged, as xterm sends them.
     */
    fun withCtrl(text: String): String {
        if (text.isEmpty()) return text
        val control = controlCode(text[0]) ?: return text
        return control + text.substring(1)
    }

    private fun typed(text: String, ctrl: Boolean) = if (ctrl) withCtrl(text) else text

    // A modified arrow is always CSI form; `5` is the Ctrl modifier.
    private fun arrow(final: Char, ctrl: Boolean, appCursor: Boolean) = when {
        ctrl -> "$ESC[1;5$final"
        appCursor -> "${ESC}O$final"
        else -> "$ESC[$final"
    }

    private fun controlCode(c: Char): Char? = when (c) {
        in 'a'..'z' -> (c.code - 'a'.code + 1).toChar()
        in 'A'..'Z' -> (c.code - 'A'.code + 1).toChar()
        '@', ' ', '2' -> '\u0000'
        '[', '3' -> '\u001b'
        '\\', '|', '4' -> '\u001c'
        ']', '5' -> '\u001d'
        '^', '~', '6' -> '\u001e'
        '_', '/', '-', '7' -> '\u001f'
        '?', '8' -> '\u007f'
        else -> null
    }
}
