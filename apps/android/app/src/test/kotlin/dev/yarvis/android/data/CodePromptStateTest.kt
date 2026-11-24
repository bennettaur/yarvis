package dev.yarvis.android.data

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodePromptStateTest {
    private val prompt = CodePromptState()

    @Test
    fun `submit answers the waiting request, trimmed, and closes the dialog`() = runTest {
        val code = async { prompt.requestCode() }
        prompt.asking.first { it }

        prompt.submit(" 123456 ")

        assertEquals("123456", code.await())
        assertFalse(prompt.asking.value)
    }

    @Test
    fun `cancel answers null`() = runTest {
        val code = async { prompt.requestCode() }
        prompt.asking.first { it }

        prompt.cancel()

        assertNull(code.await())
    }

    @Test
    fun `two requests take turns, each getting its own answer`() = runTest {
        val first = async { prompt.requestCode() }
        val second = async { prompt.requestCode() }
        runCurrent()

        prompt.submit("111111")
        runCurrent()
        assertEquals("111111", first.await())
        assertTrue("the second request gets the dialog next", prompt.asking.value)
        assertFalse(second.isCompleted)

        prompt.submit("222222")
        assertEquals("222222", second.await())
    }

    @Test
    fun `a cancelled request closes the dialog`() = runTest {
        val code = async { prompt.requestCode() }
        prompt.asking.first { it }

        code.cancel()
        runCurrent()

        assertFalse(prompt.asking.value)
    }

    @Test
    fun `submit with nothing waiting does nothing`() = runTest {
        prompt.submit("123456")
        val code = async { prompt.requestCode() }
        runCurrent()
        assertFalse("an earlier submit doesn't answer a later request", code.isCompleted)
        prompt.cancel()
        code.await()
    }
}
