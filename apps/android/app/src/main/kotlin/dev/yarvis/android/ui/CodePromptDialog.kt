package dev.yarvis.android.ui

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.yarvis.android.data.CodePromptState

/** Asks for an authenticator code when the server wants this device confirmed again. */
@Composable
fun CodePromptDialog(prompt: CodePromptState) {
    val asking by prompt.asking.collectAsStateWithLifecycle()
    if (!asking) return
    // Not saveable: a code is good for seconds and shouldn't sit in saved state.
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = {
            code = ""
            prompt.cancel()
        },
        title = { Text("Confirm it's you") },
        text = {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("Code from your authenticator app") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
        },
        confirmButton = {
            TextButton(
                enabled = code.isNotBlank(),
                onClick = {
                    prompt.submit(code)
                    code = ""
                },
            ) { Text("Confirm") }
        },
        dismissButton = {
            TextButton(onClick = {
                code = ""
                prompt.cancel()
            }) { Text("Cancel") }
        },
    )
}
